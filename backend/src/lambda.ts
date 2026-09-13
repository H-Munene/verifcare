import type { ErrorRequestHandler } from 'express';
import serverlessHttp from 'serverless-http';
import { createApp } from './app.js';
import { createRequireAuth } from './auth/middleware.js';
import { createIdTokenVerifier } from './auth/verifier.js';
import { loadConfig } from './config.js';
import { getLambdaDb, invalidateLambdaDb, isPostgresAuthError } from './db/lambdaDb.js';
import { errorHandler } from './errors.js';
import { logger } from './logger.js';

// Fail fast at cold start if this function was deployed without its DB secret wired up, rather
// than waiting for the first request to discover it. DATABASE_URL is also a valid config shape
// (per config.ts, shared with server.ts) but has no meaning for this entry point.
const config = loadConfig();
if (!config.databaseSecretArn) {
  throw new Error('DATABASE_SECRET_ARN is not set - see infra/lib/api.ts.');
}

// Cheap and synchronous - CognitoJwtVerifier.create() does not fetch the JWKS eagerly, only on
// first verify() call (then caches it), so this is safe to construct once per cold start here.
const verifier = createIdTokenVerifier(config.userPoolId, config.userPoolClientId);
const requireAuth = createRequireAuth(verifier);

const app = createApp({ requireAuth });

// Best-effort warm-up: starts the Secrets Manager round trip during the Lambda INIT phase,
// overlapping it with cold-start latency.
void getLambdaDb().catch(() => {});

// Attaches the DB client to every request when it's available, but never fails a request just
// because it isn't: a request that doesn't touch the database (e.g. /health) must keep working
// even if Secrets Manager is having a transient problem. Routes that do need the database check
// for its absence themselves (see app.ts's /health/db) and report their own 503, the same way
// server.ts's local-dev path would if db were ever missing there.
app.use(async (req, _res, next) => {
  try {
    req.app.locals.db = await getLambdaDb();
  } catch (err) {
    logger.warn({ err }, 'Could not resolve DB client for this request; proceeding without one');
  }
  next();
});

// Rotation handling: the RDS credentials secret auto-rotates every 30 days (infra/lib/database.ts).
// If a warm execution environment survives a rotation, its cached pool can fail a query with a
// Postgres authentication error once it needs a fresh connection. Rather than silently retrying
// whatever business logic the failing route already partially ran (unsafe to do generically),
// this invalidates the cached client so the *next* request rebuilds it from a fresh secret fetch,
// and tells the *current* request's client to retry.
//
// Must be registered BEFORE errors.ts's errorHandler: Express stops at the first error-handling
// middleware that doesn't call next(err), so the general catch-all has to run last, or it would
// swallow this specific case before it ever gets handled here.
const handleAuthRotation: ErrorRequestHandler = (err, _req, res, next) => {
  if (isPostgresAuthError(err)) {
    logger.warn(
      { err },
      'Postgres auth error, likely a credential rotation - invalidating cached DB client',
    );
    invalidateLambdaDb();
    res.status(503).set('Retry-After', '1').type('application/problem+json').json({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'Database credentials were rotated; please retry.',
    });
    return;
  }
  next(err);
};
app.use(handleAuthRotation);
app.use(errorHandler);

export const handler = serverlessHttp(app);

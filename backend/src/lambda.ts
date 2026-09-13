import type { ErrorRequestHandler } from 'express';
import serverlessHttp from 'serverless-http';
import { createApp } from './app.js';
import { getLambdaDb, invalidateLambdaDb, isPostgresAuthError } from './db/lambdaDb.js';

const app = createApp();

// Best-effort warm-up: starts the Secrets Manager round trip during the Lambda INIT phase,
// overlapping it with cold-start latency, without failing INIT itself if it errors - a request
// that never touches the database (e.g. /health) shouldn't fail just because Secrets Manager had a
// transient hiccup. Real failures are handled per-request by the middleware below, which awaits
// the same cached promise.
void getLambdaDb().catch(() => {});

app.use(async (req, res, next) => {
  try {
    req.app.locals.db = await getLambdaDb();
    next();
  } catch (err) {
    next(err);
  }
});

// Rotation handling: the RDS credentials secret auto-rotates every 30 days (infra/lib/database.ts).
// If a warm execution environment survives a rotation, its cached pool can fail a query with a
// Postgres authentication error once it needs a fresh connection. Rather than silently retrying
// whatever business logic the failing route already partially ran (unsafe to do generically),
// this invalidates the cached client so the *next* request rebuilds it from a fresh secret fetch,
// and tells the *current* request's client to retry.
const handleAuthRotation: ErrorRequestHandler = (err, _req, res, next) => {
  if (isPostgresAuthError(err)) {
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

export const handler = serverlessHttp(app);

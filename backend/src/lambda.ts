import type { ErrorRequestHandler } from 'express';
import serverlessHttp from 'serverless-http';
import { createApp } from './app.js';
import { createCognitoAdmin } from './auth/cognitoAdmin.js';
import { createRequireAuth, createRequireVerifiedIdentity } from './auth/middleware.js';
import { createIdTokenVerifier } from './auth/verifier.js';
import { loadConfig } from './config.js';
import { getLambdaDb, invalidateLambdaDb } from './db/lambdaDb.js';
import { isPostgresAuthError } from './db/postgresErrors.js';
import { errorHandler } from './errors.js';
import { logger } from './logger.js';

// Fail at cold start if the DB secret isn't configured.
const config = loadConfig();
if (!config.databaseSecretArn) {
  throw new Error('DATABASE_SECRET_ARN is not set - see infra/lib/api.ts.');
}

// JWKS is fetched lazily on first verify, so this is cheap.
const verifier = createIdTokenVerifier(config.userPoolId, config.userPoolClientIds);
const requireAuth = createRequireAuth(verifier);
const requireVerifiedIdentity = createRequireVerifiedIdentity(verifier);
const cognitoAdmin = createCognitoAdmin(config.userPoolId);

// See AppDependencies.resolveDb.
const app = createApp({
  requireAuth,
  requireVerifiedIdentity,
  cognitoAdmin,
  resolveDb: getLambdaDb,
});

// Warm up during INIT so the first request doesn't wait on Secrets Manager.
void getLambdaDb().catch(() => {});

// The DB secret rotates every 30 days. On a Postgres auth error, drop the cached client so the
// next request refetches the secret, and tell this client to retry. Must come before errorHandler.
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

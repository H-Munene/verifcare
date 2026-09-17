import { RekognitionClient } from '@aws-sdk/client-rekognition';
import { S3Client } from '@aws-sdk/client-s3';
import type { ErrorRequestHandler } from 'express';
import serverlessHttp from 'serverless-http';
import { createApp } from './app.js';
import { createCognitoAdmin } from './auth/cognitoAdmin.js';
import { createRequireAuth, createRequireVerifiedIdentity } from './auth/middleware.js';
import { createIdTokenVerifier } from './auth/verifier.js';
import { loadConfig } from './config.js';
import { createBiometricFaceCollection } from './db/biometricFaceCollection.js';
import { createBiometricStorage } from './db/biometricStorage.js';
import { getLambdaDb, invalidateLambdaDb } from './db/lambdaDb.js';
import { isPostgresAuthError } from './db/postgresErrors.js';
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
const verifier = createIdTokenVerifier(config.userPoolId, config.userPoolClientIds);
const requireAuth = createRequireAuth(verifier);
const requireVerifiedIdentity = createRequireVerifiedIdentity(verifier);
const cognitoAdmin = createCognitoAdmin(config.userPoolId);

// Biometric enrollment storage (HEZ-31) - S3 for the presigned upload, Rekognition for
// quality_score. Both clients are constructed with no explicit region/credentials, same as
// auth/cognitoAdmin.ts's CognitoIdentityProviderClient - the Lambda execution environment supplies
// both via its own IAM role and AWS_REGION.
const rekognitionClient = new RekognitionClient({});
const biometricStorage = createBiometricStorage({
  s3Client: new S3Client({}),
  rekognitionClient,
  bucketName: config.biometricEnrollmentsBucketName,
});
// HEZ-85's enrollment-uniqueness check - a separate concern from biometricStorage's DetectFaces
// quality scoring (see db/biometricFaceCollection.ts's header comment), sharing the same
// Rekognition client rather than constructing a second one.
const biometricFaceCollection = createBiometricFaceCollection({
  rekognitionClient,
  collectionId: config.biometricFacesCollectionId,
  bucketName: config.biometricEnrollmentsBucketName,
});

// resolveDb (not db) - see app.ts's AppDependencies.resolveDb comment for why this needs to be a
// per-request resolver createApp() wires in itself, before its routers, rather than middleware
// bolted on afterward here (that was the actual bug, fixed 2026-09-14: middleware added to an
// already-returned app, after every router and the catch-all 404 were already registered, could
// never run for any request).
const app = createApp({
  requireAuth,
  requireVerifiedIdentity,
  cognitoAdmin,
  biometricStorage,
  biometricFaceCollection,
  resolveDb: getLambdaDb,
});

// Best-effort warm-up: starts the Secrets Manager round trip during the Lambda INIT phase,
// overlapping it with cold-start latency, so the first real request doesn't pay for it - the
// resolveDb middleware above re-checks getLambdaDb() per request regardless, but that's cheap
// once warm (getLambdaDb() caches its result).
void getLambdaDb().catch(() => {});

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

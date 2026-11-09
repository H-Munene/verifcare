import { S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { createCognitoAdmin } from './auth/cognitoAdmin.js';
import { createRequireAuth, createRequireVerifiedIdentity } from './auth/middleware.js';
import { createIdTokenVerifier } from './auth/verifier.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createVisitAudioStorage } from './db/visitAudioStorage.js';
import { errorHandler } from './errors.js';
import { logger } from './logger.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file; DATABASE_URL may be set elsewhere.
}

const config = loadConfig();
if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is not set - see backend/.env.example.');
}

const pool = new Pool({ connectionString: config.databaseUrl });
const db = createDb(pool);

// Local dev uses the deployed user pool, so Cognito admin calls need local AWS credentials.
const verifier = createIdTokenVerifier(config.userPoolId, config.userPoolClientIds);
const requireAuth = createRequireAuth(verifier);
const requireVerifiedIdentity = createRequireVerifiedIdentity(verifier);
const cognitoAdmin = createCognitoAdmin(config.userPoolId);

// Same reasoning as auth/cognitoAdmin.ts above: there's no local emulator for S3 either, so local
// dev talks to the real, deployed bucket using this machine's own AWS CLI credentials.
const visitAudioStorage = createVisitAudioStorage({
  s3Client: new S3Client({}),
  bucketName: config.visitAudioBucketName,
});

const app = createApp({
  db,
  requireAuth,
  requireVerifiedIdentity,
  cognitoAdmin,
  visitAudioStorage,
  geofenceAccuracyThresholdMeters: config.geofenceAccuracyThresholdMeters,
  checkinSessionTokenTtlSeconds: config.checkinSessionTokenTtlSeconds,
  checkinQrTokenTtlSeconds: config.checkinQrTokenTtlSeconds,
});
app.use(errorHandler);

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'backend listening');
});

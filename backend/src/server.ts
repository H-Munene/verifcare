import { RekognitionClient } from '@aws-sdk/client-rekognition';
import { S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { createCognitoAdmin } from './auth/cognitoAdmin.js';
import { createRequireAuth, createRequireVerifiedIdentity } from './auth/middleware.js';
import { createIdTokenVerifier } from './auth/verifier.js';
import { loadConfig } from './config.js';
import { createBiometricFaceCollection } from './db/biometricFaceCollection.js';
import { createBiometricStorage } from './db/biometricStorage.js';
import { createCheckinFrameStorage } from './db/checkinFrameStorage.js';
import { createCheckinPhotoValidator } from './db/checkinLiveness.js';
import { createDb } from './db/client.js';
import { createFaceMatcher } from './db/faceMatch.js';
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

// Same reasoning as auth/cognitoAdmin.ts above: no local emulator for S3/Rekognition either, local
// dev talks to the same real, deployed bucket/collection, using this machine's own AWS CLI
// credentials.
const rekognitionClient = new RekognitionClient({});
const s3Client = new S3Client({});
const biometricStorage = createBiometricStorage({
  s3Client,
  rekognitionClient,
  bucketName: config.biometricEnrollmentsBucketName,
});
const biometricFaceCollection = createBiometricFaceCollection({
  rekognitionClient,
  collectionId: config.biometricFacesCollectionId,
  bucketName: config.biometricEnrollmentsBucketName,
});

// HEZ-34's check-in flow - shares the same rekognitionClient/s3Client instances above, same
// reasoning db/biometricFaceCollection.ts already gave for reusing cognitoAdmin.ts's pattern.
const checkinFrameStorage = createCheckinFrameStorage({
  s3Client,
  bucketName: config.checkinLivenessFramesBucketName,
});
const checkinPhotoValidator = createCheckinPhotoValidator({ rekognitionClient });
const checkinFaceMatcher = createFaceMatcher({ rekognitionClient });

const app = createApp({
  db,
  requireAuth,
  requireVerifiedIdentity,
  cognitoAdmin,
  biometricStorage,
  biometricFaceCollection,
  geofenceAccuracyThresholdMeters: config.geofenceAccuracyThresholdMeters,
  checkinSessionTokenTtlSeconds: config.checkinSessionTokenTtlSeconds,
  checkinLivenessFramesBucketName: config.checkinLivenessFramesBucketName,
  biometricEnrollmentsBucketName: config.biometricEnrollmentsBucketName,
  checkinLivenessMatchThresholdPercent: config.checkinLivenessMatchThresholdPercent,
  checkinPhotoValidator,
  checkinFaceMatcher,
  checkinFrameStorage,
  checkinCoPresenceWindowSeconds: config.checkinCoPresenceWindowSeconds,
});
app.use(errorHandler);

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'backend listening');
});

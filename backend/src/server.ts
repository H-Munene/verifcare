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
import { createDb } from './db/client.js';
import { errorHandler } from './errors.js';
import { logger } from './logger.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file present - fine, DATABASE_URL is presumably set some other way.
}

const config = loadConfig();
if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is not set - see backend/.env.example.');
}

const pool = new Pool({ connectionString: config.databaseUrl });
const db = createDb(pool);

// No local Cognito emulator in this project's stack - local dev verifies against the same real,
// deployed User Pool the Lambda uses (see .env.example), including AdminUpdateUserAttributes
// calls, which need the same AWS credentials this machine already has configured for the AWS CLI.
const verifier = createIdTokenVerifier(config.userPoolId, config.userPoolClientIds);
const requireAuth = createRequireAuth(verifier);
const requireVerifiedIdentity = createRequireVerifiedIdentity(verifier);
const cognitoAdmin = createCognitoAdmin(config.userPoolId);

// Same reasoning as auth/cognitoAdmin.ts above: no local emulator for S3/Rekognition either, local
// dev talks to the same real, deployed bucket/collection, using this machine's own AWS CLI
// credentials.
const rekognitionClient = new RekognitionClient({});
const biometricStorage = createBiometricStorage({
  s3Client: new S3Client({}),
  rekognitionClient,
  bucketName: config.biometricEnrollmentsBucketName,
});
const biometricFaceCollection = createBiometricFaceCollection({
  rekognitionClient,
  collectionId: config.biometricFacesCollectionId,
  bucketName: config.biometricEnrollmentsBucketName,
});

const app = createApp({
  db,
  requireAuth,
  requireVerifiedIdentity,
  cognitoAdmin,
  biometricStorage,
  biometricFaceCollection,
});
app.use(errorHandler);

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'backend listening');
});

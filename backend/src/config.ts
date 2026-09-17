// Central, validated env-var config for this service's entry points (server.ts, lambda.ts).
// Deliberately NOT imported by app.ts or any file app.test.ts pulls in - loadConfig() throws on
// invalid/missing env vars, and app.ts must stay importable with zero env vars set (app.test.ts
// calls createApp() directly, with nothing configured). Each real entry point calls loadConfig()
// explicitly, once, early in its own startup - not as an import-time side effect.

import { z } from 'zod';

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    // Local dev (server.ts) uses DATABASE_URL directly. The deployed Lambda (lambda.ts,
    // via lambdaDb.ts) resolves credentials from Secrets Manager instead, via
    // DATABASE_SECRET_ARN - never both in the same running process.
    DATABASE_URL: z.string().min(1).optional(),
    DATABASE_SECRET_ARN: z.string().min(1).optional(),
    // The Cognito User Pool JWTs are verified against (auth/verifier.ts). There is no local
    // Cognito emulator in this project's stack, so both server.ts and lambda.ts point at the same
    // real, deployed user pool.
    USER_POOL_ID: z.string().min(1),
    // One app client per client application (web, caregiver mobile, family-member mobile - see
    // infra/lib/auth.ts), all sharing this one user pool. All three must be accepted here, not
    // just the web client - a real bug found 2026-09-14: the verifier only accepted
    // USER_POOL_CLIENT_ID, so every ID token issued to either mobile app failed
    // aws-jwt-verify's clientId/audience check and got the generic 401 "invalid, expired, or
    // malformed" response, even though the token itself was perfectly valid.
    USER_POOL_CLIENT_ID: z.string().min(1),
    CAREGIVER_USER_POOL_CLIENT_ID: z.string().min(1),
    FAMILY_MEMBER_USER_POOL_CLIENT_ID: z.string().min(1),
    // The S3 bucket biometric enrollment images are uploaded to (routes/biometricEnrollments.ts,
    // HEZ-31). Already passed into the Lambda's environment by infra/lib/api.ts since HEZ-21, but
    // unread by any code here until now.
    BIOMETRIC_ENROLLMENTS_BUCKET_NAME: z.string().min(1),
    // The Rekognition Collection ID enrollment uniqueness checks search/index against
    // (db/biometricFaceCollection.ts, HEZ-85).
    BIOMETRIC_FACES_COLLECTION_ID: z.string().min(1),
  })
  .refine((env) => env.DATABASE_URL !== undefined || env.DATABASE_SECRET_ARN !== undefined, {
    message: 'Either DATABASE_URL (local dev) or DATABASE_SECRET_ARN (Lambda) must be set.',
  });

export interface Config {
  port: number;
  databaseUrl: string | undefined;
  databaseSecretArn: string | undefined;
  userPoolId: string;
  // Every app client the ID token verifier must accept - see the schema comment above.
  userPoolClientIds: [string, string, string];
  biometricEnrollmentsBucketName: string;
  biometricFacesCollectionId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(config)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return {
    port: result.data.PORT,
    databaseUrl: result.data.DATABASE_URL,
    databaseSecretArn: result.data.DATABASE_SECRET_ARN,
    userPoolId: result.data.USER_POOL_ID,
    userPoolClientIds: [
      result.data.USER_POOL_CLIENT_ID,
      result.data.CAREGIVER_USER_POOL_CLIENT_ID,
      result.data.FAMILY_MEMBER_USER_POOL_CLIENT_ID,
    ],
    biometricEnrollmentsBucketName: result.data.BIOMETRIC_ENROLLMENTS_BUCKET_NAME,
    biometricFacesCollectionId: result.data.BIOMETRIC_FACES_COLLECTION_ID,
  };
}

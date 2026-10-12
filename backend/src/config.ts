// Validated env config for server.ts and lambda.ts. Keep it out of app.ts so tests can import the
// app without any env vars set.

import { z } from 'zod';

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    // DATABASE_URL locally; DATABASE_SECRET_ARN in Lambda.
    DATABASE_URL: z.string().min(1).optional(),
    DATABASE_SECRET_ARN: z.string().min(1).optional(),
    // Local dev uses the deployed user pool too.
    USER_POOL_ID: z.string().min(1),
    // One app client each for web, caregiver mobile and family-member mobile.
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
    // routes/checkin.ts's geofence check (HEZ-33). Both are the "configurable numeric defaults"
    // architecture.md itself flags as tunable, not fixed - confirmed with the user as 20m/600s
    // (10 minutes) for now; HEZ-74 (device testing pass, milestone 6) is expected to revisit both
    // against real device behavior.
    GEOFENCE_ACCURACY_THRESHOLD_METERS: z.coerce.number().positive().default(20),
    CHECKIN_SESSION_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    // The S3 bucket check-in photos are uploaded to (routes/checkin.ts, HEZ-34) - a separate
    // bucket from BIOMETRIC_ENROLLMENTS_BUCKET_NAME on purpose (see infra/lib/storage.ts's comment
    // on CheckinLivenessFramesBucket): these photos are purely transient verification artifacts,
    // never needed again once a pass/fail result is computed, unlike long-lived enrollment
    // reference images.
    CHECKIN_LIVENESS_FRAMES_BUCKET_NAME: z.string().min(1),
    // Rekognition CompareFaces match threshold - architecture.md's own settled number ("verification's
    // 80%", distinct from enrollment-uniqueness's stricter 95% - see db/faceMatch.ts, HEZ-36).
    CHECKIN_LIVENESS_MATCH_THRESHOLD_PERCENT: z.coerce.number().min(0).max(100).default(80),
    // How long after the caregiver check-in step passes the dependant step must be submitted
    // (routes/checkin.ts, HEZ-35) - architecture.md's own "bounded time window... for example two
    // minutes" framing, confirmed with the user as exactly 2 minutes for now, the same
    // "configurable, not yet finalized" treatment as the geofence/session pair above.
    CHECKIN_CO_PRESENCE_WINDOW_SECONDS: z.coerce.number().int().positive().default(120),
  })
  .refine((env) => env.DATABASE_URL !== undefined || env.DATABASE_SECRET_ARN !== undefined, {
    message: 'Either DATABASE_URL (local dev) or DATABASE_SECRET_ARN (Lambda) must be set.',
  });

export interface Config {
  port: number;
  databaseUrl: string | undefined;
  databaseSecretArn: string | undefined;
  userPoolId: string;
  userPoolClientIds: [string, string, string];
  biometricEnrollmentsBucketName: string;
  biometricFacesCollectionId: string;
  geofenceAccuracyThresholdMeters: number;
  checkinSessionTokenTtlSeconds: number;
  checkinLivenessFramesBucketName: string;
  checkinLivenessMatchThresholdPercent: number;
  checkinCoPresenceWindowSeconds: number;
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
    geofenceAccuracyThresholdMeters: result.data.GEOFENCE_ACCURACY_THRESHOLD_METERS,
    checkinSessionTokenTtlSeconds: result.data.CHECKIN_SESSION_TOKEN_TTL_SECONDS,
    checkinLivenessFramesBucketName: result.data.CHECKIN_LIVENESS_FRAMES_BUCKET_NAME,
    checkinLivenessMatchThresholdPercent: result.data.CHECKIN_LIVENESS_MATCH_THRESHOLD_PERCENT,
    checkinCoPresenceWindowSeconds: result.data.CHECKIN_CO_PRESENCE_WINDOW_SECONDS,
  };
}

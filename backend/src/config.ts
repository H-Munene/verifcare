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
    // routes/checkin.ts's geofence check (HEZ-33). Both are the "configurable numeric defaults"
    // architecture.md itself flags as tunable, not fixed - confirmed with the user as 20m/600s
    // (10 minutes) for now; HEZ-74 (device testing pass, milestone 6) is expected to revisit both
    // against real device behavior.
    GEOFENCE_ACCURACY_THRESHOLD_METERS: z.coerce.number().positive().default(20),
    CHECKIN_SESSION_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    // How long a family member's check-in code stays valid (routes/checkinCode.ts). Short, so a
    // screenshot goes stale almost at once; the family app fetches a fresh code while the screen
    // is open, so a caregiver mid-scan is never left holding an expired one.
    CHECKIN_QR_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60),
    // Where the visit's 30-second recording is stored (routes/visitAudio.ts).
    VISIT_AUDIO_BUCKET_NAME: z.string().min(1),
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
  geofenceAccuracyThresholdMeters: number;
  checkinSessionTokenTtlSeconds: number;
  checkinQrTokenTtlSeconds: number;
  visitAudioBucketName: string;
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
    geofenceAccuracyThresholdMeters: result.data.GEOFENCE_ACCURACY_THRESHOLD_METERS,
    checkinSessionTokenTtlSeconds: result.data.CHECKIN_SESSION_TOKEN_TTL_SECONDS,
    checkinQrTokenTtlSeconds: result.data.CHECKIN_QR_TOKEN_TTL_SECONDS,
    visitAudioBucketName: result.data.VISIT_AUDIO_BUCKET_NAME,
  };
}

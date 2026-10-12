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
  };
}

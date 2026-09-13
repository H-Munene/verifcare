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
  })
  .refine((env) => env.DATABASE_URL !== undefined || env.DATABASE_SECRET_ARN !== undefined, {
    message: 'Either DATABASE_URL (local dev) or DATABASE_SECRET_ARN (Lambda) must be set.',
  });

export interface Config {
  port: number;
  databaseUrl: string | undefined;
  databaseSecretArn: string | undefined;
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
  };
}

// Builds the Drizzle client from the Secrets Manager DB secret and caches it across warm
// invocations. No Express dependency, so other Lambdas can use it too.

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { createDb, type Db } from './client.js';
import { parseRdsSecretJson, poolConfigFromRdsSecret } from './rdsSecret.js';

const secretsClient = new SecretsManagerClient({});

async function fetchSecretString(secretArn: string): Promise<string> {
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!result.SecretString) {
    throw new Error(`Secrets Manager returned no SecretString for ${secretArn}.`);
  }
  return result.SecretString;
}

async function buildLambdaDb(): Promise<Db> {
  const secretArn = process.env.DATABASE_SECRET_ARN;
  if (!secretArn) {
    throw new Error(
      'DATABASE_SECRET_ARN is not set - this function must be VPC-attached and given the RDS secret ARN (see infra/lib/api.ts).',
    );
  }
  const secretString = await fetchSecretString(secretArn);
  const secret = parseRdsSecretJson(secretString);
  const pool = new Pool(poolConfigFromRdsSecret(secret));
  return createDb(pool);
}

let cached: Promise<Db> | undefined;

// Cleared on failure so one transient error doesn't stick for the life of the environment.
export function getLambdaDb(builder: () => Promise<Db> = buildLambdaDb): Promise<Db> {
  if (!cached) {
    cached = builder().catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}

// Forces a fresh secret fetch on the next call, e.g. after the password has rotated.
export function invalidateLambdaDb(): void {
  cached = undefined;
}

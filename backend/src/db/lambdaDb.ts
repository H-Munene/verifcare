// Resolves the api Lambda's DB credentials from Secrets Manager and builds/caches the Drizzle
// client for reuse across warm invocations of the same execution environment. The only file in
// this project that imports @aws-sdk/client-secrets-manager - deliberately framework-agnostic
// (no Express coupling), so the missed-visit-sweep Lambda's real logic (a separate, already-
// tracked follow-up) can call getLambdaDb() directly and unchanged, instead of inventing a second
// way to do the same thing.

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

// Cached across invocations for as long as this execution environment stays warm. On rejection,
// the cache is cleared before rethrowing so a single transient Secrets Manager error during a cold
// start doesn't permanently poison every later invocation on that same warm environment.
export function getLambdaDb(builder: () => Promise<Db> = buildLambdaDb): Promise<Db> {
  if (!cached) {
    cached = builder().catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}

// Forces the next getLambdaDb() call to rebuild from a fresh secret fetch. Used by lambda.ts's
// error-handling middleware when a query fails with a Postgres authentication error - the RDS
// credentials secret rotates its password automatically every 30 days (infra/lib/database.ts),
// and a warm execution environment's cached pool can outlive a rotation.
export function invalidateLambdaDb(): void {
  cached = undefined;
}

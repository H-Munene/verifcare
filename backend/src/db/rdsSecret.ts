// Pure parsing/mapping of the RDS-generated Secrets Manager secret JSON into a node-postgres
// PoolConfig. No AWS SDK import here on purpose - this file never makes a network call, so it's
// fully unit-testable without AWS credentials or a real secret.

import type { PoolConfig } from 'pg';
import { RDS_CA_BUNDLE_PEM } from './rdsCaBundle.js';

// The standard shape rds.DatabaseSecret (infra/lib/database.ts) generates.
export interface RdsSecretJson {
  username: string;
  password: string;
  engine: string;
  host: string;
  port: number;
  dbname: string;
  dbInstanceIdentifier: string;
}

const REQUIRED_STRING_FIELDS = [
  'username',
  'password',
  'engine',
  'host',
  'dbname',
  'dbInstanceIdentifier',
] as const;

export function parseRdsSecretJson(raw: string): RdsSecretJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('RDS secret value is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('RDS secret value must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      throw new Error(`RDS secret is missing required string field "${field}".`);
    }
  }

  const port = Number(record.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `RDS secret has a missing or invalid "port" field: ${JSON.stringify(record.port)}.`,
    );
  }

  return {
    username: record.username as string,
    password: record.password as string,
    engine: record.engine as string,
    host: record.host as string,
    port,
    dbname: record.dbname as string,
    dbInstanceIdentifier: record.dbInstanceIdentifier as string,
  };
}

export function poolConfigFromRdsSecret(secret: RdsSecretJson): PoolConfig {
  return {
    host: secret.host,
    port: secret.port,
    database: secret.dbname,
    user: secret.username,
    password: secret.password,
    // Each concurrent Lambda invocation gets its own execution environment and thus its own pool -
    // a large per-environment pool size would exhaust db.t4g.micro's connection ceiling under any
    // real concurrency, not a stylistic choice.
    max: 2,
    // node-postgres's equivalent of sslmode=verify-full: validates the server's certificate chain
    // against the RDS CA bundle, not just "encrypted but unverified". RDS for PostgreSQL 15+
    // already defaults rds.force_ssl=1 server-side, so this is the client-side half of that.
    ssl: {
      rejectUnauthorized: true,
      ca: RDS_CA_BUNDLE_PEM,
    },
  };
}

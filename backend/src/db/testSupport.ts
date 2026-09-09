// Shared setup for integration tests that need a real Postgres connection (Linear HEZ-11).
// Not used by the app itself - HEZ-27 builds the actual runtime client separately, though it
// should follow the same `casing: 'snake_case'` convention established here and in drizzle.config.ts.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from './schema.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, '../../drizzle');

// Every table name, for the truncate-between-tests helper below. Kept as a plain list rather than
// derived from `schema` reflectively, so it stays an explicit, reviewable part of this file.
const allTableNames = [
  'users',
  'caregivers',
  'dependants',
  'dependant_family_members',
  'biometric_enrollments',
  'visit_schedules',
  'verification_events',
  'verification_attempts',
  'audio_records',
  'consent_records',
  'notification_log',
  'audit_log',
] as const;

let pool: Pool | undefined;
let db: NodePgDatabase<typeof schema> | undefined;

export function getTestDatabaseUrl(): string | undefined {
  return process.env.TEST_DATABASE_URL;
}

export async function setupTestDb(): Promise<NodePgDatabase<typeof schema>> {
  const url = getTestDatabaseUrl();
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set - point it at a disposable Postgres database (see backend/.env.example) to run the DB-enforcement integration tests.',
    );
  }
  pool = new Pool({ connectionString: url });
  db = drizzle(pool, { schema, casing: 'snake_case' });
  await migrate(db, { migrationsFolder });
  return db;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!db) {
    throw new Error('setupTestDb() must run first (e.g. in a beforeAll hook).');
  }
  return db;
}

export async function truncateAllTables(): Promise<void> {
  const database = getDb();
  await database.execute(sql.raw(`TRUNCATE TABLE ${allTableNames.join(', ')} CASCADE`));
}

export async function teardownTestDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}

// Shared setup for integration tests that need a real Postgres connection (Linear HEZ-11).
// Not used by the app itself - see db/client.ts's createDb() (HEZ-27) for the runtime client,
// which this file now reuses so the `casing: 'snake_case'` convention lives in exactly one place.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createDb, type Db } from './client.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, '../../drizzle');

// Every table name, for the truncate-between-tests helper below. Kept as a plain list rather than
// derived from `schema` reflectively, so it stays an explicit, reviewable part of this file.
const allTableNames = [
  'users',
  'caregivers',
  'dependants',
  'dependant_family_members',
  'dependant_care_tasks',
  'biometric_enrollments',
  'visit_schedules',
  'visit_task_completions',
  'verification_events',
  'verification_attempts',
  'audio_records',
  'consent_records',
  'notification_log',
  'audit_log',
] as const;

let pool: Pool | undefined;
let db: Db | undefined;

export function getTestDatabaseUrl(): string | undefined {
  return process.env.TEST_DATABASE_URL;
}

export async function setupTestDb(): Promise<Db> {
  const url = getTestDatabaseUrl();
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set - point it at a disposable Postgres database (see backend/.env.example) to run the DB-enforcement integration tests.',
    );
  }
  pool = new Pool({ connectionString: url });
  db = createDb(pool);
  await migrate(db, { migrationsFolder });
  return db;
}

export function getDb(): Db {
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

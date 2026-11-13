// Shared setup for integration tests that need a real Postgres connection.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { createDb, type Db } from './client.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(dirname, '../../drizzle');

const allTableNames = [
  'users',
  'caregivers',
  'dependants',
  'dependant_family_members',
  'dependant_care_tasks',
  'visit_plans',
  'visit_plan_clusters',
  'visit_schedules',
  'visit_recovery_cases',
  'visit_recovery_offers',
  'visit_task_completions',
  'verification_events',
  'verification_attempts',
  'checkin_qr_tokens',
  'checkin_override_requests',
  'visit_resolutions',
  'voice_checks',
  'voice_enrollments',
  'audio_records',
  'consent_records',
  'terms_acceptances',
  'family_link_requests',
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

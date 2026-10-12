// Integration tests for the DB-level enforcement in the hand-written migrations (triggers,
// EXCLUDE constraints). Needs TEST_DATABASE_URL; skipped when it isn't set.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  caregivers,
  dependants,
  users,
  verificationAttempts,
  visitSchedules,
} from './schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from './testSupport.js';

interface PostgresError extends Error {
  code?: string;
  constraint?: string;
}

// drizzle-orm wraps the real node-postgres error in a DrizzleQueryError, with the actual
// Postgres error (message, code, constraint, ...) on `.cause` - assert against that, not the
// wrapper's own generic "Failed query: ..." message.
async function getRejectionCause(promise: Promise<unknown>): Promise<PostgresError> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown } | undefined)?.cause;
    if (cause instanceof Error) return cause;
    throw new Error(`Expected rejection to have an Error cause, got: ${String(error)}`, {
      cause: error,
    });
  }
  throw new Error('Expected promise to reject, but it resolved');
}

async function insertUser(role: 'supervisor' | 'caregiver' | 'family_member') {
  const db = getDb();
  const [row] = await db
    .insert(users)
    .values({
      cognitoSub: `cognito-${randomUUID()}`,
      phoneNumber: role === 'supervisor' ? undefined : `+2547${randomUUID().slice(0, 8)}`,
      fullName: `Test ${role}`,
      role,
    })
    .returning();
  if (!row) throw new Error('insertUser: insert returned no row');
  return row;
}

async function insertCaregiver() {
  const user = await insertUser('caregiver');
  const db = getDb();
  const [row] = await db.insert(caregivers).values({ userId: user.id }).returning();
  if (!row) throw new Error('insertCaregiver: insert returned no row');
  return row;
}

async function insertDependant(registeredById: string) {
  const db = getDb();
  const [row] = await db
    .insert(dependants)
    .values({
      fullName: 'Test Dependant',
      dob: '1950-01-01',
      geofenceLat: -1.2921,
      geofenceLng: 36.8219,
      geofenceRadiusMeters: 100,
      registeredBy: registeredById,
    })
    .returning();
  if (!row) throw new Error('insertDependant: insert returned no row');
  return row;
}

async function insertVisitSchedule(params: {
  caregiverId: string;
  dependantId: string;
  createdById: string;
  start: string;
  end: string;
  status?: 'scheduled' | 'cancelled';
}) {
  const db = getDb();
  return db
    .insert(visitSchedules)
    .values({
      caregiverId: params.caregiverId,
      dependantId: params.dependantId,
      scheduledStart: new Date(params.start),
      scheduledEnd: new Date(params.end),
      createdBy: params.createdById,
      status: params.status ?? 'scheduled',
    })
    .returning();
}

const hasTestDb = Boolean(getTestDatabaseUrl());

describe.skipIf(!hasTestDb)('DB-level enforcement', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  describe('set_updated_at trigger', () => {
    it('bumps updated_at on UPDATE at the database level', async () => {
      const db = getDb();
      const user = await insertUser('supervisor');

      // A raw UPDATE, not routed through any application "touch updated_at" logic - the
      // guarantee this test protects is that the trigger enforces this for every writer.
      await db.update(users).set({ fullName: 'Updated Name' }).where(eq(users.id, user.id));

      const [updated] = await db.select().from(users).where(eq(users.id, user.id));
      expect(updated?.fullName).toBe('Updated Name');
      expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(
        new Date(user.updatedAt).getTime(),
      );
    });
  });

  describe('phone-required-unless-supervisor CHECK', () => {
    it('allows a supervisor with no phone number', async () => {
      await expect(insertUser('supervisor')).resolves.toBeDefined();
    });

    it('rejects a caregiver with no phone number', async () => {
      const db = getDb();
      const cause = await getRejectionCause(
        db.insert(users).values({
          cognitoSub: `cognito-${randomUUID()}`,
          fullName: 'No Phone Caregiver',
          role: 'caregiver',
        }),
      );
      expect(cause.message).toMatch(/chk_users_phone_required_unless_supervisor/);
    });
  });

  describe('append-only enforcement', () => {
    it('rejects UPDATE on verification_attempts', async () => {
      const db = getDb();
      const registrar = await insertUser('family_member');
      const caregiver = await insertCaregiver();
      const dependant = await insertDependant(registrar.id);
      const [visit] = await insertVisitSchedule({
        caregiverId: caregiver.userId,
        dependantId: dependant.id,
        createdById: registrar.id,
        start: '2026-09-10T09:00:00Z',
        end: '2026-09-10T10:00:00Z',
      });
      const [attempt] = await db
        .insert(verificationAttempts)
        .values({ visitScheduleId: visit!.id, attemptType: 'geofence', passed: true })
        .returning();

      const cause = await getRejectionCause(
        db
          .update(verificationAttempts)
          .set({ passed: false })
          .where(eq(verificationAttempts.id, attempt!.id)),
      );
      expect(cause.code).toBe('P0001');
      expect(cause.message).toMatch(/append-only/);
    });

    it('rejects DELETE on verification_attempts', async () => {
      const db = getDb();
      const registrar = await insertUser('family_member');
      const caregiver = await insertCaregiver();
      const dependant = await insertDependant(registrar.id);
      const [visit] = await insertVisitSchedule({
        caregiverId: caregiver.userId,
        dependantId: dependant.id,
        createdById: registrar.id,
        start: '2026-09-10T09:00:00Z',
        end: '2026-09-10T10:00:00Z',
      });
      const [attempt] = await db
        .insert(verificationAttempts)
        .values({ visitScheduleId: visit!.id, attemptType: 'geofence', passed: true })
        .returning();

      const cause = await getRejectionCause(
        db.delete(verificationAttempts).where(eq(verificationAttempts.id, attempt!.id)),
      );
      expect(cause.code).toBe('P0001');
      expect(cause.message).toMatch(/append-only/);
    });

    it('rejects UPDATE and DELETE on audit_log', async () => {
      const db = getDb();
      const [entry] = await db
        .insert(auditLog)
        .values({ action: 'create', entityType: 'dependants', entityId: randomUUID() })
        .returning();

      const updateCause = await getRejectionCause(
        db.update(auditLog).set({ action: 'update' }).where(eq(auditLog.id, entry!.id)),
      );
      expect(updateCause.message).toMatch(/append-only/);

      const deleteCause = await getRejectionCause(
        db.delete(auditLog).where(eq(auditLog.id, entry!.id)),
      );
      expect(deleteCause.message).toMatch(/append-only/);
    });
  });

  describe('visit_schedules double-booking EXCLUDE constraints', () => {
    it('rejects an overlapping booking for the same caregiver', async () => {
      const registrar = await insertUser('family_member');
      const caregiver = await insertCaregiver();
      const dependantA = await insertDependant(registrar.id);
      const dependantB = await insertDependant(registrar.id);

      await insertVisitSchedule({
        caregiverId: caregiver.userId,
        dependantId: dependantA.id,
        createdById: registrar.id,
        start: '2026-09-10T09:00:00Z',
        end: '2026-09-10T10:00:00Z',
      });

      const cause = await getRejectionCause(
        insertVisitSchedule({
          caregiverId: caregiver.userId,
          dependantId: dependantB.id, // different dependant, same caregiver, overlapping time
          createdById: registrar.id,
          start: '2026-09-10T09:30:00Z',
          end: '2026-09-10T10:30:00Z',
        }),
      );
      expect(cause.code).toBe('23P01');
      expect(cause.constraint).toBe('excl_visit_schedules_caregiver_overlap');
    });

    it('rejects an overlapping booking for the same dependant', async () => {
      const registrar = await insertUser('family_member');
      const caregiverA = await insertCaregiver();
      const caregiverB = await insertCaregiver();
      const dependant = await insertDependant(registrar.id);

      await insertVisitSchedule({
        caregiverId: caregiverA.userId,
        dependantId: dependant.id,
        createdById: registrar.id,
        start: '2026-09-10T09:00:00Z',
        end: '2026-09-10T10:00:00Z',
      });

      const cause = await getRejectionCause(
        insertVisitSchedule({
          caregiverId: caregiverB.userId, // different caregiver, same dependant, overlapping time
          dependantId: dependant.id,
          createdById: registrar.id,
          start: '2026-09-10T09:30:00Z',
          end: '2026-09-10T10:30:00Z',
        }),
      );
      expect(cause.code).toBe('23P01');
      expect(cause.constraint).toBe('excl_visit_schedules_dependant_overlap');
    });

    it('allows an overlapping booking once the earlier one is cancelled', async () => {
      const registrar = await insertUser('family_member');
      const caregiver = await insertCaregiver();
      const dependantA = await insertDependant(registrar.id);
      const dependantB = await insertDependant(registrar.id);

      await insertVisitSchedule({
        caregiverId: caregiver.userId,
        dependantId: dependantA.id,
        createdById: registrar.id,
        start: '2026-09-10T09:00:00Z',
        end: '2026-09-10T10:00:00Z',
        status: 'cancelled',
      });

      const overlapping = insertVisitSchedule({
        caregiverId: caregiver.userId,
        dependantId: dependantB.id,
        createdById: registrar.id,
        start: '2026-09-10T09:30:00Z',
        end: '2026-09-10T10:30:00Z',
      });

      await expect(overlapping).resolves.toHaveLength(1);
    });

    it('allows non-overlapping bookings for the same caregiver', async () => {
      const registrar = await insertUser('family_member');
      const caregiver = await insertCaregiver();
      const dependantA = await insertDependant(registrar.id);
      const dependantB = await insertDependant(registrar.id);

      await insertVisitSchedule({
        caregiverId: caregiver.userId,
        dependantId: dependantA.id,
        createdById: registrar.id,
        start: '2026-09-10T09:00:00Z',
        end: '2026-09-10T10:00:00Z',
      });

      const backToBack = insertVisitSchedule({
        caregiverId: caregiver.userId,
        dependantId: dependantB.id,
        createdById: registrar.id,
        start: '2026-09-10T10:00:00Z', // starts exactly when the first ends - not an overlap
        end: '2026-09-10T11:00:00Z',
      });

      await expect(backToBack).resolves.toHaveLength(1);
    });
  });
});

// Integration test for sweepMissedVisits (HEZ-23 follow-up) against a real local Postgres - see
// routes/visitSchedules.integration.test.ts's header comment for why (real timestamp comparison
// behavior, not a faked query builder).

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from './auth/verifier.js';
import * as schema from './db/schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from './db/testSupport.js';
import { sweepMissedVisits } from './missedVisitSweep.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

async function createTestUser(
  sub: string,
  role: UserRole,
  phoneNumber: string,
): Promise<typeof schema.users.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.users)
    .values({ cognitoSub: sub, fullName: `User ${sub}`, phoneNumber, role })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test user.');
  }
  return row;
}

async function createTestCaregiver(
  sub: string,
  phoneNumber: string,
): Promise<typeof schema.caregivers.$inferSelect> {
  const user = await createTestUser(sub, 'caregiver', phoneNumber);
  const db = getDb();
  const [row] = await db.insert(schema.caregivers).values({ userId: user.id }).returning();
  if (!row) {
    throw new Error('Failed to insert test caregiver.');
  }
  return row;
}

async function createTestDependant(
  registeredById: string,
): Promise<typeof schema.dependants.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.dependants)
    .values({
      fullName: 'Test Dependant',
      dob: '1950-01-01',
      geofenceLat: -1.2921,
      geofenceLng: 36.8219,
      geofenceRadiusMeters: 100,
      registeredBy: registeredById,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test dependant.');
  }
  return row;
}

async function createTestVisit(
  caregiverId: string,
  dependantId: string,
  createdById: string,
  status: string,
  scheduledEnd: Date,
): Promise<typeof schema.visitSchedules.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.visitSchedules)
    .values({
      caregiverId,
      dependantId,
      scheduledStart: new Date(scheduledEnd.getTime() - 60 * 60 * 1000),
      scheduledEnd,
      status,
      createdBy: createdById,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test visit.');
  }
  return row;
}

describe.skipIf(!hasTestDb)('sweepMissedVisits (real Postgres)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('marks a scheduled-but-never-checked-in visit as missed once its scheduledEnd has passed', async () => {
    const db = getDb();
    const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
    const caregiver = await createTestCaregiver('cg-1', '+254700000002');
    const dependant = await createTestDependant(supervisor.id);
    const visit = await createTestVisit(
      caregiver.userId,
      dependant.id,
      supervisor.id,
      'scheduled',
      new Date(Date.now() - 60 * 60 * 1000),
    );

    const { missedVisitIds } = await sweepMissedVisits(db);

    expect(missedVisitIds).toEqual([visit.id]);
    const [updated] = await db
      .select()
      .from(schema.visitSchedules)
      .where(eq(schema.visitSchedules.id, visit.id));
    expect(updated?.status).toBe('missed');
  });

  it('raises one shared missed-visit alert per visit, audited, and never a second on re-run', async () => {
    const db = getDb();
    const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
    const caregiver = await createTestCaregiver('cg-1', '+254700000002');
    const dependant = await createTestDependant(supervisor.id);
    const visit = await createTestVisit(
      caregiver.userId,
      dependant.id,
      supervisor.id,
      'scheduled',
      new Date(Date.now() - 60 * 60 * 1000),
    );

    await sweepMissedVisits(db);
    // A visit re-marked by hand and swept again must not get a second alert.
    await db
      .update(schema.visitSchedules)
      .set({ status: 'scheduled' })
      .where(eq(schema.visitSchedules.id, visit.id));
    await sweepMissedVisits(db);

    const alerts = await db.select().from(schema.notificationLog);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: 'missed_visit',
      visitScheduleId: visit.id,
      recipientUserId: null,
      channel: 'in_app',
      acknowledgedAt: null,
    });
    expect(alerts[0]?.sentAt).toBeInstanceOf(Date);

    const audit = await db.select().from(schema.auditLog);
    expect(audit[0]).toMatchObject({
      actorUserId: null,
      action: 'visit_schedule.mark_missed',
      entityType: 'visit_schedule',
      entityId: visit.id,
    });
  });

  it('marks a checked-in-but-never-checked-out visit as missed once its scheduledEnd has passed', async () => {
    const db = getDb();
    const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
    const caregiver = await createTestCaregiver('cg-1', '+254700000002');
    const dependant = await createTestDependant(supervisor.id);
    const visit = await createTestVisit(
      caregiver.userId,
      dependant.id,
      supervisor.id,
      'in_progress',
      new Date(Date.now() - 60 * 60 * 1000),
    );

    const { missedVisitIds } = await sweepMissedVisits(db);

    expect(missedVisitIds).toEqual([visit.id]);
  });

  it('leaves a visit alone if its scheduledEnd has not passed yet', async () => {
    const db = getDb();
    const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
    const caregiver = await createTestCaregiver('cg-1', '+254700000002');
    const dependant = await createTestDependant(supervisor.id);
    const visit = await createTestVisit(
      caregiver.userId,
      dependant.id,
      supervisor.id,
      'scheduled',
      new Date(Date.now() + 60 * 60 * 1000),
    );

    const { missedVisitIds } = await sweepMissedVisits(db);

    expect(missedVisitIds).toEqual([]);
    const [unchanged] = await db
      .select()
      .from(schema.visitSchedules)
      .where(eq(schema.visitSchedules.id, visit.id));
    expect(unchanged?.status).toBe('scheduled');
  });

  it('leaves an already-completed or cancelled visit alone even if its scheduledEnd has passed', async () => {
    const db = getDb();
    const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
    const caregiver = await createTestCaregiver('cg-1', '+254700000002');
    const dependant = await createTestDependant(supervisor.id);
    await createTestVisit(
      caregiver.userId,
      dependant.id,
      supervisor.id,
      'completed',
      new Date(Date.now() - 60 * 60 * 1000),
    );
    // A non-overlapping window - the same caregiver/dependant pair back-to-back would otherwise
    // trip `excl_visit_schedules_caregiver_overlap`/`excl_visit_schedules_dependant_overlap`.
    await createTestVisit(
      caregiver.userId,
      dependant.id,
      supervisor.id,
      'cancelled',
      new Date(Date.now() - 3 * 60 * 60 * 1000),
    );

    const { missedVisitIds } = await sweepMissedVisits(db);

    expect(missedVisitIds).toEqual([]);
  });
});

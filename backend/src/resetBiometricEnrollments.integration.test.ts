// Integration test for resetBiometricEnrollments against a real local Postgres, like
// missedVisitSweep.integration.test.ts - the point is the real DELETE and its guard.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from './db/schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from './db/testSupport.js';
import {
  RESET_BIOMETRIC_ENROLLMENTS_CONFIRMATION,
  resetBiometricEnrollments,
} from './resetBiometricEnrollments.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

async function seedEnrollments(): Promise<void> {
  const db = getDb();
  const [supervisor] = await db
    .insert(schema.users)
    .values({
      cognitoSub: 'sup-1',
      fullName: 'Supervisor',
      phoneNumber: '+254700000001',
      role: 'supervisor',
    })
    .returning();
  const [caregiverUser] = await db
    .insert(schema.users)
    .values({
      cognitoSub: 'cg-1',
      fullName: 'Caregiver',
      phoneNumber: '+254700000002',
      role: 'caregiver',
    })
    .returning();
  if (!supervisor || !caregiverUser) {
    throw new Error('Failed to insert test users.');
  }
  await db.insert(schema.caregivers).values({ userId: caregiverUser.id });
  const [dependant] = await db
    .insert(schema.dependants)
    .values({
      fullName: 'Test Dependant',
      dob: '1950-01-01',
      geofenceLat: -1.2921,
      geofenceLng: 36.8219,
      geofenceRadiusMeters: 20,
      registeredBy: supervisor.id,
    })
    .returning();
  if (!dependant) {
    throw new Error('Failed to insert test dependant.');
  }
  await db.insert(schema.biometricEnrollments).values([
    {
      subjectType: 'caregiver',
      caregiverId: caregiverUser.id,
      s3Key: 'caregiver/a.jpg',
      imageOrder: 1,
      enrolledBy: supervisor.id,
    },
    {
      subjectType: 'dependant',
      dependantId: dependant.id,
      s3Key: 'dependant/a.jpg',
      imageOrder: 1,
      status: 'superseded',
      enrolledBy: supervisor.id,
    },
    {
      subjectType: 'dependant',
      dependantId: dependant.id,
      s3Key: 'dependant/b.jpg',
      imageOrder: 1,
      enrolledBy: supervisor.id,
    },
  ]);
}

describe.skipIf(!hasTestDb)('resetBiometricEnrollments (real Postgres)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await seedEnrollments();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('only counts without the exact confirmation', async () => {
    const db = getDb();
    for (const confirm of [undefined, '', 'yes', `${RESET_BIOMETRIC_ENROLLMENTS_CONFIRMATION} `]) {
      const result = await resetBiometricEnrollments(db, confirm);
      expect(result.deleted).toBe(false);
    }
    expect(await db.select().from(schema.biometricEnrollments)).toHaveLength(3);
  });

  it('reports what was there, then deletes every row of every subject and status', async () => {
    const db = getDb();
    const result = await resetBiometricEnrollments(db, RESET_BIOMETRIC_ENROLLMENTS_CONFIRMATION);
    expect(result).toEqual({
      deleted: true,
      counts: [
        { subjectType: 'caregiver', status: 'active', count: 1 },
        { subjectType: 'dependant', status: 'active', count: 1 },
        { subjectType: 'dependant', status: 'superseded', count: 1 },
      ],
    });
    expect(await db.select().from(schema.biometricEnrollments)).toHaveLength(0);
    // The people themselves are untouched - only their photos go.
    expect(await db.select().from(schema.caregivers)).toHaveLength(1);
    expect(await db.select().from(schema.dependants)).toHaveLength(1);
  });
});

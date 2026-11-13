// GET /voice-checks against a real Postgres: supervisors only, each person's own recordings, and
// an audited read.

import { eq } from 'drizzle-orm';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthenticatedUser, UserRole } from '../auth/verifier.js';
import * as schema from '../db/schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../db/testSupport.js';
import { createVoiceChecksRouter } from './voiceChecks.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function auth(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

type Body = {
  enrolment: { enrolled: boolean };
  items: { result: string | null; score: number | null; caregiverName: string }[];
};

describe.skipIf(!hasTestDb)('voice checks (real Postgres)', () => {
  let app: Express;
  let caregiverId: string;
  let dependantId: string;
  const supervisor = auth('sup-1', 'supervisor');

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    app = express();
    app.locals.db = getDb();
    const requireAuth: express.RequestHandler = (req, _res, next) => {
      req.auth = JSON.parse(
        Buffer.from(req.headers['x-test-auth'] as string, 'base64url').toString('utf8'),
      ) as AuthenticatedUser;
      next();
    };
    app.use('/voice-checks', createVoiceChecksRouter({ requireAuth }));

    const users = await getDb()
      .insert(schema.users)
      .values([
        {
          cognitoSub: 'sup-1',
          fullName: 'Sarah',
          phoneNumber: '+254700000001',
          role: 'supervisor',
        },
        { cognitoSub: 'cg-1', fullName: 'Amina', phoneNumber: '+254700000002', role: 'caregiver' },
      ])
      .returning();
    const [supervisorRow, caregiverRow] = users;
    caregiverId = caregiverRow!.id;
    await getDb().insert(schema.caregivers).values({ userId: caregiverId });
    const [dependant] = await getDb()
      .insert(schema.dependants)
      .values({
        fullName: 'Joseph',
        dob: '1950-01-01',
        geofenceLat: -1.28,
        geofenceLng: 36.81,
        geofenceRadiusMeters: 100,
        registeredBy: supervisorRow!.id,
      })
      .returning();
    dependantId = dependant!.id;
    const [visit] = await getDb()
      .insert(schema.visitSchedules)
      .values({
        caregiverId,
        dependantId,
        scheduledStart: new Date('2026-11-13T09:00:00Z'),
        scheduledEnd: new Date('2026-11-13T10:00:00Z'),
        status: 'completed',
        createdBy: supervisorRow!.id,
      })
      .returning();
    await getDb()
      .insert(schema.verificationEvents)
      .values({ visitScheduleId: visit!.id, checkinAt: new Date('2026-11-13T09:05:00Z') });
    const recordings = await getDb()
      .insert(schema.audioRecords)
      .values([
        { verificationEventId: visit!.id, role: 'dependant', s3Key: 'd', durationSeconds: 20 },
        { verificationEventId: visit!.id, role: 'caregiver', s3Key: 'c', durationSeconds: 15 },
      ])
      .returning();
    await getDb()
      .insert(schema.voiceChecks)
      .values({
        audioRecordId: recordings[0]!.id,
        result: 'mismatch',
        score: 0.31,
        threshold: 0.5,
      });
  });

  const get = (query: string, who = supervisor) =>
    request(app).get(`/voice-checks?${query}`).set('x-test-auth', who);

  it("lists only the person's own recordings, with their results", async () => {
    const dependant = (await get(`dependantId=${dependantId}`)).body as Body;
    const caregiver = (await get(`caregiverId=${caregiverId}`)).body as Body;

    expect(dependant.items).toMatchObject([
      { result: 'mismatch', score: 0.31, caregiverName: 'Amina' },
    ]);
    expect(caregiver.items).toMatchObject([{ result: null, score: null }]);
    expect(dependant.enrolment).toEqual({ enrolled: false, enrolledAt: null });
  });

  it('is for supervisors only, needs exactly one person, and is audit-logged', async () => {
    expect((await get(`dependantId=${dependantId}`, auth('cg-1', 'caregiver'))).status).toBe(403);
    expect((await get(`dependantId=${dependantId}&caregiverId=${caregiverId}`)).status).toBe(400);
    expect((await get('')).status).toBe(400);

    await get(`dependantId=${dependantId}`);
    const audit = await getDb()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'voice_checks.view'));
    expect(audit).toMatchObject([{ entityType: 'dependant', entityId: dependantId }]);
  });
});

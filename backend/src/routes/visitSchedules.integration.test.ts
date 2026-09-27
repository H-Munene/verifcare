// Integration tests for POST/GET /visit-schedules, GET/PATCH /visit-schedules/{visitScheduleId}
// (HEZ-32) against a real local Postgres - see users.integration.test.ts's header comment for why
// (real EXCLUDE-constraint/transaction behavior, not a faked query builder) and for the
// test-auth-header pattern used here too.

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
import { createVisitSchedulesRouter } from './visitSchedules.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function testAuthHeader(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

interface VisitScheduleBody {
  id: string;
  caregiverId: string;
  dependantId: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: string;
  createdBy: string;
}
interface VisitSchedulePageBody {
  items: VisitScheduleBody[];
  nextCursor: string | null;
}
interface ProblemBody {
  title: string;
  detail?: string;
}
interface VerificationAuditBody {
  event: { visitScheduleId: string; checkinAt: string | null } | null;
  attempts: { attemptType: string; passed: boolean }[];
}
function visitBody(response: request.Response): VisitScheduleBody {
  return response.body as VisitScheduleBody;
}
function pageBody(response: request.Response): VisitSchedulePageBody {
  return response.body as VisitSchedulePageBody;
}
function problemBody(response: request.Response): ProblemBody {
  return response.body as ProblemBody;
}
function verificationAuditBody(response: request.Response): VerificationAuditBody {
  return response.body as VerificationAuditBody;
}

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.locals.db = getDb();

  const requireAuth: express.RequestHandler = (req, res, next) => {
    const header = req.headers['x-test-auth'];
    if (typeof header !== 'string') {
      res.status(401).json({ title: 'Unauthorized' });
      return;
    }
    req.auth = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as AuthenticatedUser;
    next();
  };

  app.use('/visit-schedules', createVisitSchedulesRouter({ requireAuth }));
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ title: 'Internal Server Error', message: String(err) });
    },
  );
  return app;
}

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

// Scheduling needs an active photo for both people (the scheduling guardrail), so test caregivers
// and dependants get one unless a test is specifically about its absence.
async function enrollPhoto(
  subject: { caregiverId: string } | { dependantId: string },
  enrolledBy: string,
  status: 'active' | 'flagged' = 'active',
): Promise<void> {
  const db = getDb();
  const id = 'caregiverId' in subject ? subject.caregiverId : subject.dependantId;
  await db.insert(schema.biometricEnrollments).values({
    ...('caregiverId' in subject
      ? { subjectType: 'caregiver' as const, caregiverId: subject.caregiverId }
      : { subjectType: 'dependant' as const, dependantId: subject.dependantId }),
    s3Key: `test/${id}/${status}.jpg`,
    imageOrder: 1,
    status,
    ...(status === 'flagged' && {
      matchedSubjectType: 'caregiver' as const,
      matchedSubjectId: id,
      matchedSimilarity: 99,
    }),
    enrolledBy,
  });
}

// Scheduling also needs an active biometric_verification consent for both people (the consent
// guardrail), so test caregivers and dependants get one too unless a test is about its absence.
async function grantBiometricConsent(
  subject: { caregiverId: string } | { dependantId: string },
  grantedBy: string,
): Promise<void> {
  await getDb()
    .insert(schema.consentRecords)
    .values({
      ...('caregiverId' in subject
        ? { subjectType: 'caregiver' as const, caregiverId: subject.caregiverId }
        : { subjectType: 'dependant' as const, dependantId: subject.dependantId }),
      consentType: 'biometric_verification',
      grantedBy,
    });
}

async function createTestCaregiver(
  sub: string,
  phoneNumber: string,
  { withPhoto = true, withConsent = true }: { withPhoto?: boolean; withConsent?: boolean } = {},
): Promise<typeof schema.caregivers.$inferSelect> {
  const user = await createTestUser(sub, 'caregiver', phoneNumber);
  const db = getDb();
  const [row] = await db.insert(schema.caregivers).values({ userId: user.id }).returning();
  if (!row) {
    throw new Error('Failed to insert test caregiver.');
  }
  if (withPhoto) {
    await enrollPhoto({ caregiverId: row.userId }, user.id);
  }
  if (withConsent) {
    await grantBiometricConsent({ caregiverId: row.userId }, user.id);
  }
  return row;
}

async function createTestDependant(
  registeredById: string,
  { withPhoto = true, withConsent = true }: { withPhoto?: boolean; withConsent?: boolean } = {},
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
  if (withPhoto) {
    await enrollPhoto({ dependantId: row.id }, registeredById);
  }
  if (withConsent) {
    await grantBiometricConsent({ dependantId: row.id }, registeredById);
  }
  return row;
}

async function linkFamilyMember(dependantId: string, familyMemberUserId: string): Promise<void> {
  const db = getDb();
  await db.insert(schema.dependantFamilyMembers).values({
    dependantId,
    familyMemberUserId,
    isPrimaryContact: true,
    addedBy: familyMemberUserId,
  });
}

function visitPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheduledStart: '2026-10-01T09:00:00Z',
    scheduledEnd: '2026-10-01T10:00:00Z',
    ...overrides,
  };
}

async function createInProgressVisit(
  caregiverId: string,
  dependantId: string,
  createdById: string,
): Promise<typeof schema.visitSchedules.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.visitSchedules)
    .values({
      caregiverId,
      dependantId,
      scheduledStart: new Date('2026-10-01T09:00:00Z'),
      scheduledEnd: new Date('2026-10-01T10:00:00Z'),
      status: 'in_progress',
      createdBy: createdById,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test visit.');
  }
  // Mirrors HEZ-35's own effect on a real check-in: verification_events.checkin_at is always set
  // before visit_schedules.status ever becomes 'in_progress' - checkout's own CHECK constraint
  // (chk_verification_events_checkout_after_checkin) requires it.
  await db
    .insert(schema.verificationEvents)
    .values({ visitScheduleId: row.id, checkinAt: new Date() });
  return row;
}

async function createTestCareTask(
  dependantId: string,
  createdById: string,
  overrides: Partial<typeof schema.dependantCareTasks.$inferInsert> = {},
): Promise<typeof schema.dependantCareTasks.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.dependantCareTasks)
    .values({ dependantId, title: 'Assist with bathing', createdBy: createdById, ...overrides })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test care task.');
  }
  return row;
}

describe.skipIf(!hasTestDb)(
  'POST/GET /visit-schedules, GET/PATCH /visit-schedules/{visitScheduleId} (real Postgres)',
  () => {
    let app: Express;

    beforeAll(async () => {
      await setupTestDb();
    });

    beforeEach(async () => {
      await truncateAllTables();
      app = buildTestApp();
    });

    afterAll(async () => {
      await teardownTestDb();
    });

    describe('POST /visit-schedules', () => {
      it('lets a supervisor schedule a visit', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);

        const response = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependant.id }));

        expect(response.status).toBe(201);
        expect(visitBody(response)).toMatchObject({
          caregiverId: caregiver.userId,
          dependantId: dependant.id,
          caregiverDisplayName: 'User cg-1',
          dependantDisplayName: 'Test Dependant',
          status: 'scheduled',
          createdBy: supervisor.id,
        });
      });

      it('refuses to schedule until both people have an active photo (422)', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002', { withPhoto: false });
        const dependant = await createTestDependant(supervisor.id, { withPhoto: false });
        const schedule = () =>
          request(app)
            .post('/visit-schedules')
            .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
            .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependant.id }));

        let response = await schedule();
        expect(response.status).toBe(422);
        expect(problemBody(response).detail).toContain(
          'the caregiver and the dependant have a photo',
        );

        // A photo still waiting for a supervisor's review can't be matched at check-in yet.
        await enrollPhoto({ caregiverId: caregiver.userId }, supervisor.id, 'flagged');
        response = await schedule();
        expect(response.status).toBe(422);

        await enrollPhoto({ caregiverId: caregiver.userId }, supervisor.id);
        response = await schedule();
        expect(response.status).toBe(422);
        expect(problemBody(response).detail).toContain('until the dependant has a photo');

        await enrollPhoto({ dependantId: dependant.id }, supervisor.id);
        expect((await schedule()).status).toBe(201);
      });

      it('refuses to schedule until both people have active photo-verification consent (422)', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002', {
          withConsent: false,
        });
        const dependant = await createTestDependant(supervisor.id, { withConsent: false });
        const schedule = () =>
          request(app)
            .post('/visit-schedules')
            .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
            .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependant.id }));

        let response = await schedule();
        expect(response.status).toBe(422);
        expect(problemBody(response).detail).toContain('the caregiver and the dependant');
        expect(problemBody(response).detail).toContain('consented to photo identity verification');

        // Audio consent alone doesn't cover the photo check, and a revoked consent doesn't count.
        await getDb()
          .insert(schema.consentRecords)
          .values([
            {
              subjectType: 'caregiver',
              caregiverId: caregiver.userId,
              consentType: 'audio_cognitive_monitoring',
              grantedBy: supervisor.id,
            },
            {
              subjectType: 'caregiver',
              caregiverId: caregiver.userId,
              consentType: 'biometric_verification',
              grantedBy: supervisor.id,
              revokedAt: new Date('2026-09-20T08:00:00Z'),
            },
          ]);
        response = await schedule();
        expect(response.status).toBe(422);
        expect(problemBody(response).detail).toContain('until the caregiver and the dependant');

        await grantBiometricConsent({ caregiverId: caregiver.userId }, supervisor.id);
        response = await schedule();
        expect(response.status).toBe(422);
        expect(problemBody(response).detail).toContain('until the dependant');
        expect(problemBody(response).detail).not.toContain('the caregiver');

        await grantBiometricConsent({ dependantId: dependant.id }, supervisor.id);
        expect((await schedule()).status).toBe(201);
      });

      it('rejects a caregiver or family_member caller with 403', async () => {
        await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(
          (await createTestUser('sup-2', 'supervisor', '+254700000003')).id,
        );

        const response = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependant.id }));

        expect(response.status).toBe(403);
      });

      it('rejects an unknown caregiverId with a clean 400', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const dependant = await createTestDependant(supervisor.id);

        const response = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(
            visitPayload({
              caregiverId: '00000000-0000-0000-0000-000000000000',
              dependantId: dependant.id,
            }),
          );

        expect(response.status).toBe(400);
        expect(problemBody(response).detail).toMatch(/caregiverId/);
      });

      it('rejects scheduledEnd before scheduledStart with a clean 400', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);

        const response = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(
            visitPayload({
              caregiverId: caregiver.userId,
              dependantId: dependant.id,
              scheduledStart: '2026-10-01T10:00:00Z',
              scheduledEnd: '2026-10-01T09:00:00Z',
            }),
          );

        expect(response.status).toBe(400);
      });

      it('surfaces a double-booked caregiver as a clean 409, not a raw DB error', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependantA = await createTestDependant(supervisor.id);
        const dependantB = await createTestDependant(supervisor.id);

        await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependantA.id }));

        const response = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(
            visitPayload({
              caregiverId: caregiver.userId,
              dependantId: dependantB.id,
              scheduledStart: '2026-10-01T09:30:00Z',
              scheduledEnd: '2026-10-01T10:30:00Z',
            }),
          );

        expect(response.status).toBe(409);
        expect(problemBody(response).detail).toMatch(/caregiver/i);
      });
    });

    describe('GET /visit-schedules (list, role-scoped)', () => {
      it('lets a supervisor see every visit', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependant.id }));

        const response = await request(app)
          .get('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(200);
        expect(pageBody(response).items).toHaveLength(1);
      });

      it('scopes a caregiver to only their own assigned visits', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiverA = await createTestCaregiver('cg-a', '+254700000002');
        const caregiverB = await createTestCaregiver('cg-b', '+254700000003');
        const dependant = await createTestDependant(supervisor.id);
        await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiverA.userId, dependantId: dependant.id }));
        await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(
            visitPayload({
              caregiverId: caregiverB.userId,
              dependantId: dependant.id,
              scheduledStart: '2026-10-02T09:00:00Z',
              scheduledEnd: '2026-10-02T10:00:00Z',
            }),
          );

        const response = await request(app)
          .get('/visit-schedules')
          .set('x-test-auth', testAuthHeader('cg-a', 'caregiver'));

        expect(response.status).toBe(200);
        expect(pageBody(response).items).toHaveLength(1);
        expect(pageBody(response).items[0]).toMatchObject({ caregiverId: caregiverA.userId });
      });

      it('scopes a family_member to only visits for a dependant they are linked to', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const linkedDependant = await createTestDependant(supervisor.id);
        const unlinkedDependant = await createTestDependant(supervisor.id);
        const familyMember = await createTestUser('fm-1', 'family_member', '+254700000004');
        await linkFamilyMember(linkedDependant.id, familyMember.id);

        await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: linkedDependant.id }));
        await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(
            visitPayload({
              caregiverId: caregiver.userId,
              dependantId: unlinkedDependant.id,
              scheduledStart: '2026-10-02T09:00:00Z',
              scheduledEnd: '2026-10-02T10:00:00Z',
            }),
          );

        const response = await request(app)
          .get('/visit-schedules')
          .set('x-test-auth', testAuthHeader('fm-1', 'family_member'));

        expect(response.status).toBe(200);
        expect(pageBody(response).items).toHaveLength(1);
        expect(pageBody(response).items[0]).toMatchObject({ dependantId: linkedDependant.id });
      });
    });

    describe('GET /visit-schedules/{visitScheduleId}', () => {
      it('forbids a caregiver from viewing a visit assigned to someone else', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiverA = await createTestCaregiver('cg-a', '+254700000002');
        await createTestCaregiver('cg-b', '+254700000003');
        const dependant = await createTestDependant(supervisor.id);
        const created = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiverA.userId, dependantId: dependant.id }));

        const response = await request(app)
          .get(`/visit-schedules/${visitBody(created).id}`)
          .set('x-test-auth', testAuthHeader('cg-b', 'caregiver'));

        expect(response.status).toBe(403);
      });
    });

    describe('PATCH /visit-schedules/{visitScheduleId}', () => {
      it('lets a supervisor cancel a visit', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const created = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependant.id }));

        const response = await request(app)
          .patch(`/visit-schedules/${visitBody(created).id}`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({ status: 'cancelled' });

        expect(response.status).toBe(200);
        expect(visitBody(response).status).toBe('cancelled');
      });

      it('refuses to reschedule once a photo is gone, but still lets the visit be cancelled', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const created = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependant.id }));
        expect(created.status).toBe(201);
        // e.g. the photos were reset to be retaken.
        await getDb().delete(schema.biometricEnrollments);

        const moved = await request(app)
          .patch(`/visit-schedules/${visitBody(created).id}`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({ scheduledStart: '2026-10-02T09:00:00Z', scheduledEnd: '2026-10-02T10:00:00Z' });
        expect(moved.status).toBe(422);

        const cancelled = await request(app)
          .patch(`/visit-schedules/${visitBody(created).id}`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({ status: 'cancelled' });
        expect(cancelled.status).toBe(200);
      });

      it('refuses to reschedule once a consent is revoked, but still lets the visit be cancelled', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const created = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependant.id }));
        expect(created.status).toBe(201);
        await getDb()
          .update(schema.consentRecords)
          .set({ revokedAt: new Date() })
          .where(eq(schema.consentRecords.dependantId, dependant.id));

        const moved = await request(app)
          .patch(`/visit-schedules/${visitBody(created).id}`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({ scheduledStart: '2026-10-02T09:00:00Z', scheduledEnd: '2026-10-02T10:00:00Z' });
        expect(moved.status).toBe(422);
        expect(problemBody(moved).detail).toContain('until the dependant');

        const cancelled = await request(app)
          .patch(`/visit-schedules/${visitBody(created).id}`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({ status: 'cancelled' });
        expect(cancelled.status).toBe(200);
      });

      it('rejects a caregiver trying to reschedule their own visit with 403', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const created = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependant.id }));

        const response = await request(app)
          .patch(`/visit-schedules/${visitBody(created).id}`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
          .send({ status: 'cancelled' });

        expect(response.status).toBe(403);
      });

      it('allows an overlapping booking once the earlier one is cancelled first', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependantA = await createTestDependant(supervisor.id);
        const dependantB = await createTestDependant(supervisor.id);
        const created = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependantA.id }));

        await request(app)
          .patch(`/visit-schedules/${visitBody(created).id}`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({ status: 'cancelled' });

        const response = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependantB.id }));

        expect(response.status).toBe(201);
      });

      it('rejects rescheduling into an overlapping window with a clean 409', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependantA = await createTestDependant(supervisor.id);
        const dependantB = await createTestDependant(supervisor.id);
        const first = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependantA.id }));
        const second = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(
            visitPayload({
              caregiverId: caregiver.userId,
              dependantId: dependantB.id,
              scheduledStart: '2026-10-01T11:00:00Z',
              scheduledEnd: '2026-10-01T12:00:00Z',
            }),
          );

        const response = await request(app)
          .patch(`/visit-schedules/${visitBody(second).id}`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({
            scheduledStart: visitBody(first).scheduledStart,
            scheduledEnd: visitBody(first).scheduledEnd,
          });

        expect(response.status).toBe(409);
      });

      it('rejects a partial update that would put scheduledEnd before scheduledStart', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const created = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependant.id }));

        const response = await request(app)
          .patch(`/visit-schedules/${visitBody(created).id}`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({ scheduledEnd: '2026-10-01T08:00:00Z' });

        expect(response.status).toBe(400);

        const db = getDb();
        const [row] = await db
          .select()
          .from(schema.visitSchedules)
          .where(eq(schema.visitSchedules.id, visitBody(created).id));
        expect(row?.scheduledEnd.toISOString()).toBe(visitBody(created).scheduledEnd);
      });
    });

    describe('POST /visit-schedules/{visitScheduleId}/checkout (HEZ-39)', () => {
      it('checks the assigned caregiver out: sets checkout_at, flips status to completed', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const visit = await createInProgressVisit(caregiver.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .post(`/visit-schedules/${visit.id}/checkout`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

        expect(response.status).toBe(200);
        expect(visitBody(response).status).toBe('completed');

        const db = getDb();
        const [event] = await db
          .select()
          .from(schema.verificationEvents)
          .where(eq(schema.verificationEvents.visitScheduleId, visit.id));
        expect(event?.checkoutAt).not.toBeNull();
      });

      it('rejects a supervisor caller with 403 - no supervisor override', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const visit = await createInProgressVisit(caregiver.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .post(`/visit-schedules/${visit.id}/checkout`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(403);
      });

      it('rejects a caregiver checking out a visit assigned to someone else with 403', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiverA = await createTestCaregiver('cg-a', '+254700000002');
        await createTestCaregiver('cg-b', '+254700000003');
        const dependant = await createTestDependant(supervisor.id);
        const visit = await createInProgressVisit(caregiverA.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .post(`/visit-schedules/${visit.id}/checkout`)
          .set('x-test-auth', testAuthHeader('cg-b', 'caregiver'));

        expect(response.status).toBe(403);
      });

      it('rejects a visit that has not been checked in yet with 409', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const created = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependant.id }));

        const response = await request(app)
          .post(`/visit-schedules/${visitBody(created).id}/checkout`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

        expect(response.status).toBe(409);
      });

      it('rejects checking out a visit that is already completed with 409', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const visit = await createInProgressVisit(caregiver.userId, dependant.id, supervisor.id);
        const first = await request(app)
          .post(`/visit-schedules/${visit.id}/checkout`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));
        expect(first.status).toBe(200);

        const response = await request(app)
          .post(`/visit-schedules/${visit.id}/checkout`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

        expect(response.status).toBe(409);
      });

      it('returns 404 for a nonexistent visit', async () => {
        await createTestCaregiver('cg-1', '+254700000002');
        const response = await request(app)
          .post('/visit-schedules/01a0bfb1-61b8-7260-b9e3-2d549e1bda49/checkout')
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

        expect(response.status).toBe(404);
      });

      it('blocks checkout with a 409 naming the task when a required care task is unaddressed', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        await createTestCareTask(dependant.id, supervisor.id, {
          title: 'Assist with bathing',
          required: true,
        });
        const visit = await createInProgressVisit(caregiver.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .post(`/visit-schedules/${visit.id}/checkout`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

        expect(response.status).toBe(409);
        expect(problemBody(response).detail).toMatch(/Assist with bathing/);

        const db = getDb();
        const [unchanged] = await db
          .select()
          .from(schema.visitSchedules)
          .where(eq(schema.visitSchedules.id, visit.id));
        expect(unchanged?.status).toBe('in_progress');
      });

      it('allows checkout once every required task has any status recorded, and ignores non-required/retired tasks', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const required = await createTestCareTask(dependant.id, supervisor.id, {
          title: 'Assist with bathing',
          required: true,
        });
        await createTestCareTask(dependant.id, supervisor.id, {
          title: 'Optional task',
          required: false,
        });
        await createTestCareTask(dependant.id, supervisor.id, {
          title: 'Retired required task',
          required: true,
          active: false,
        });
        const visit = await createInProgressVisit(caregiver.userId, dependant.id, supervisor.id);
        const db = getDb();
        // "Addressed" means any status was recorded, not necessarily 'completed' - matches the
        // real-world "Required task alert" semantics this blocking mirrors.
        await db.insert(schema.visitTaskCompletions).values({
          visitScheduleId: visit.id,
          careTaskId: required.id,
          status: 'not_applicable',
        });

        const response = await request(app)
          .post(`/visit-schedules/${visit.id}/checkout`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

        expect(response.status).toBe(200);
        expect(visitBody(response).status).toBe('completed');
      });
    });

    describe('GET /visit-schedules/{visitScheduleId}/verification (HEZ-42)', () => {
      it('returns a null event and empty attempts for a visit that has never checked in', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const created = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependant.id }));

        const response = await request(app)
          .get(`/visit-schedules/${visitBody(created).id}/verification`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ event: null, attempts: [] });
      });

      it('returns the event and its attempts for an in-progress visit', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const visit = await createInProgressVisit(caregiver.userId, dependant.id, supervisor.id);
        const db = getDb();
        await db.insert(schema.verificationAttempts).values({
          visitScheduleId: visit.id,
          attemptType: 'geofence',
          passed: true,
          attemptedAt: new Date(),
        });

        const response = await request(app)
          .get(`/visit-schedules/${visit.id}/verification`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(200);
        const body = verificationAuditBody(response);
        expect(body.event).toMatchObject({ visitScheduleId: visit.id });
        expect(body.event?.checkinAt).not.toBeNull();
        expect(body.attempts).toHaveLength(1);
        expect(body.attempts[0]).toMatchObject({ attemptType: 'geofence', passed: true });
      });

      it('lets the assigned caregiver view their own visit', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const visit = await createInProgressVisit(caregiver.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .get(`/visit-schedules/${visit.id}/verification`)
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

        expect(response.status).toBe(200);
      });

      it("rejects a caregiver viewing another caregiver's visit with 403", async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiverA = await createTestCaregiver('cg-a', '+254700000002');
        await createTestCaregiver('cg-b', '+254700000003');
        const dependant = await createTestDependant(supervisor.id);
        const visit = await createInProgressVisit(caregiverA.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .get(`/visit-schedules/${visit.id}/verification`)
          .set('x-test-auth', testAuthHeader('cg-b', 'caregiver'));

        expect(response.status).toBe(403);
      });

      it('lets a linked family member view a visit for their dependant', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const familyMember = await createTestUser('fam-1', 'family_member', '+254700000004');
        await linkFamilyMember(dependant.id, familyMember.id);
        const visit = await createInProgressVisit(caregiver.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .get(`/visit-schedules/${visit.id}/verification`)
          .set('x-test-auth', testAuthHeader('fam-1', 'family_member'));

        expect(response.status).toBe(200);
      });

      it('rejects a family member not linked to the dependant with 403', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        await createTestUser('fam-1', 'family_member', '+254700000004');
        const visit = await createInProgressVisit(caregiver.userId, dependant.id, supervisor.id);

        const response = await request(app)
          .get(`/visit-schedules/${visit.id}/verification`)
          .set('x-test-auth', testAuthHeader('fam-1', 'family_member'));

        expect(response.status).toBe(403);
      });

      it('returns 404 for a nonexistent visit', async () => {
        await createTestUser('sup-1', 'supervisor', '+254700000001');
        const response = await request(app)
          .get('/visit-schedules/01a0bfb1-61b8-7260-b9e3-2d549e1bda49/verification')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(404);
      });
    });

    describe('GET /visit-schedules/{visitScheduleId}/task-outcomes', () => {
      // A completed visit with two recorded outcomes (one done, one skipped with a reason) and one
      // care task the caregiver never recorded anything for.
      async function completedVisitWithOutcomes() {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const familyMember = await createTestUser('fam-1', 'family_member', '+254700000004');
        await linkFamilyMember(dependant.id, familyMember.id);
        const visit = await createInProgressVisit(caregiver.userId, dependant.id, supervisor.id);
        const bathing = await createTestCareTask(dependant.id, supervisor.id);
        const walk = await createTestCareTask(dependant.id, supervisor.id, {
          title: 'Short walk',
          required: false,
        });
        await createTestCareTask(dependant.id, supervisor.id, { title: 'Never recorded' });
        const db = getDb();
        await db.insert(schema.visitTaskCompletions).values([
          { visitScheduleId: visit.id, careTaskId: bathing.id, status: 'completed' },
          {
            visitScheduleId: visit.id,
            careTaskId: walk.id,
            status: 'not_completed',
            reason: 'client_declined',
            notes: 'Too tired today',
          },
        ]);
        await db
          .update(schema.visitSchedules)
          .set({ status: 'completed' })
          .where(eq(schema.visitSchedules.id, visit.id));
        return { visit };
      }

      it('lets a linked family member read the recorded outcomes of a completed visit', async () => {
        const { visit } = await completedVisitWithOutcomes();

        const response = await request(app)
          .get(`/visit-schedules/${visit.id}/task-outcomes`)
          .set('x-test-auth', testAuthHeader('fam-1', 'family_member'));

        expect(response.status).toBe(200);
        // Only recorded outcomes - "Never recorded" has no completion row, so it isn't listed.
        expect(response.body).toMatchObject([
          { title: 'Assist with bathing', status: 'completed', reason: null, required: true },
          {
            title: 'Short walk',
            status: 'not_completed',
            reason: 'client_declined',
            notes: 'Too tired today',
            required: false,
          },
        ]);
      });

      it('lets a supervisor read them too', async () => {
        const { visit } = await completedVisitWithOutcomes();

        const response = await request(app)
          .get(`/visit-schedules/${visit.id}/task-outcomes`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(2);
      });

      it('returns an empty list for a visit that never started', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const dependant = await createTestDependant(supervisor.id);
        const created = await request(app)
          .post('/visit-schedules')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(visitPayload({ caregiverId: caregiver.userId, dependantId: dependant.id }));

        const response = await request(app)
          .get(`/visit-schedules/${visitBody(created).id}/task-outcomes`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(200);
        expect(response.body).toEqual([]);
      });

      it('rejects a family member not linked to the dependant with 403', async () => {
        const { visit } = await completedVisitWithOutcomes();
        await createTestUser('fam-2', 'family_member', '+254700000005');

        const response = await request(app)
          .get(`/visit-schedules/${visit.id}/task-outcomes`)
          .set('x-test-auth', testAuthHeader('fam-2', 'family_member'));

        expect(response.status).toBe(403);
      });

      it("rejects a caregiver reading another caregiver's visit with 403", async () => {
        const { visit } = await completedVisitWithOutcomes();
        await createTestCaregiver('cg-2', '+254700000006');

        const response = await request(app)
          .get(`/visit-schedules/${visit.id}/task-outcomes`)
          .set('x-test-auth', testAuthHeader('cg-2', 'caregiver'));

        expect(response.status).toBe(403);
      });

      it('returns 404 for a nonexistent visit', async () => {
        await createTestUser('sup-1', 'supervisor', '+254700000001');
        const response = await request(app)
          .get('/visit-schedules/01a0bfb1-61b8-7260-b9e3-2d549e1bda49/task-outcomes')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(404);
      });
    });
  },
);

// Integration tests for GET /notifications, POST /notifications/{id}/acknowledge (HEZ-41)
// against a real local Postgres - see users.integration.test.ts's header comment for why (real
// filtering/ownership behavior, not a faked query builder) and for the test-auth-header pattern
// used here too.

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
import { createNotificationsRouter } from './notifications.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function testAuthHeader(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

interface NotificationBody {
  id: string;
  type: 'missed_visit' | 'cognitive_risk';
  recipientUserId: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}
interface NotificationPageBody {
  items: NotificationBody[];
  nextCursor: string | null;
}
function notificationBody(response: request.Response): NotificationBody {
  return response.body as NotificationBody;
}
function pageBody(response: request.Response): NotificationPageBody {
  return response.body as NotificationPageBody;
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

  app.use('/notifications', createNotificationsRouter({ requireAuth }));
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

let testVisitCounter = 0;

// notification_log's own chk_notification_log_related_entity CHECK requires a real
// visit_schedules row (missed_visit) or audio_records row (cognitive_risk) - this builds whichever
// chain a given type needs, rather than every test constructing it by hand.
async function createTestVisitScheduleId(): Promise<string> {
  const db = getDb();
  testVisitCounter += 1;
  const supervisor = await createTestUser(
    `notif-sup-${testVisitCounter}`,
    'supervisor',
    `+25470000${String(9000 + testVisitCounter)}`,
  );
  const caregiverUser = await createTestUser(
    `notif-cg-${testVisitCounter}`,
    'caregiver',
    `+25470000${String(8000 + testVisitCounter)}`,
  );
  const [caregiver] = await db
    .insert(schema.caregivers)
    .values({ userId: caregiverUser.id })
    .returning();
  if (!caregiver) {
    throw new Error('Failed to insert test caregiver.');
  }
  const [dependant] = await db
    .insert(schema.dependants)
    .values({
      fullName: 'Test Dependant',
      dob: '1950-01-01',
      geofenceLat: -1.2921,
      geofenceLng: 36.8219,
      geofenceRadiusMeters: 100,
      registeredBy: supervisor.id,
    })
    .returning();
  if (!dependant) {
    throw new Error('Failed to insert test dependant.');
  }
  const [visit] = await db
    .insert(schema.visitSchedules)
    .values({
      caregiverId: caregiver.userId,
      dependantId: dependant.id,
      scheduledStart: new Date('2026-10-01T09:00:00Z'),
      scheduledEnd: new Date('2026-10-01T10:00:00Z'),
      createdBy: supervisor.id,
    })
    .returning();
  if (!visit) {
    throw new Error('Failed to insert test visit.');
  }
  return visit.id;
}

async function createTestAudioRecordId(): Promise<string> {
  const db = getDb();
  const visitScheduleId = await createTestVisitScheduleId();
  await db.insert(schema.verificationEvents).values({ visitScheduleId });
  const [audioRecord] = await db
    .insert(schema.audioRecords)
    .values({ verificationEventId: visitScheduleId, s3Key: `test/${visitScheduleId}.wav` })
    .returning();
  if (!audioRecord) {
    throw new Error('Failed to insert test audio record.');
  }
  return audioRecord.id;
}

async function createTestNotification(
  recipientUserId: string,
  type: 'missed_visit' | 'cognitive_risk' = 'missed_visit',
): Promise<typeof schema.notificationLog.$inferSelect> {
  const db = getDb();
  const values =
    type === 'missed_visit'
      ? { type, recipientUserId, visitScheduleId: await createTestVisitScheduleId() }
      : { type, recipientUserId, audioRecordId: await createTestAudioRecordId() };
  const [row] = await db.insert(schema.notificationLog).values(values).returning();
  if (!row) {
    throw new Error('Failed to insert test notification.');
  }
  return row;
}

describe.skipIf(!hasTestDb)(
  'GET /notifications, POST /notifications/{id}/acknowledge (real Postgres)',
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

    describe('GET /notifications', () => {
      it('lets a supervisor see the whole inbox, not just notifications addressed to them', async () => {
        const supervisorA = await createTestUser('sup-a', 'supervisor', '+254700000001');
        const supervisorB = await createTestUser('sup-b', 'supervisor', '+254700000002');
        await createTestNotification(supervisorA.id);
        await createTestNotification(supervisorB.id);

        const response = await request(app)
          .get('/notifications')
          .set('x-test-auth', testAuthHeader('sup-a', 'supervisor'));

        expect(response.status).toBe(200);
        expect(pageBody(response).items).toHaveLength(2);
      });

      it('gives a non-supervisor caller only notifications addressed to them', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const familyMember = await createTestUser('fam-1', 'family_member', '+254700000003');
        await createTestNotification(supervisor.id);
        await createTestNotification(familyMember.id);

        const response = await request(app)
          .get('/notifications')
          .set('x-test-auth', testAuthHeader('fam-1', 'family_member'));

        expect(response.status).toBe(200);
        expect(pageBody(response).items).toHaveLength(1);
        expect(pageBody(response).items[0]?.recipientUserId).toBe(familyMember.id);
      });

      it('filters by type', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        await createTestNotification(supervisor.id, 'missed_visit');
        await createTestNotification(supervisor.id, 'cognitive_risk');

        const response = await request(app)
          .get('/notifications?type=cognitive_risk')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(200);
        expect(pageBody(response).items).toHaveLength(1);
        expect(pageBody(response).items[0]?.type).toBe('cognitive_risk');
      });

      it('filters by acknowledged', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const unacked = await createTestNotification(supervisor.id);
        const acked = await createTestNotification(supervisor.id);
        const db = getDb();
        await db
          .update(schema.notificationLog)
          .set({ acknowledgedAt: new Date(), acknowledgedBy: supervisor.id })
          .where(eq(schema.notificationLog.id, acked.id));

        const response = await request(app)
          .get('/notifications?acknowledged=false')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(200);
        expect(pageBody(response).items).toHaveLength(1);
        expect(pageBody(response).items[0]?.id).toBe(unacked.id);
      });
    });

    describe('POST /notifications/{id}/acknowledge', () => {
      it('lets any supervisor acknowledge a notification addressed to a different supervisor', async () => {
        const supervisorA = await createTestUser('sup-a', 'supervisor', '+254700000001');
        const supervisorB = await createTestUser('sup-b', 'supervisor', '+254700000002');
        const notification = await createTestNotification(supervisorA.id);

        const response = await request(app)
          .post(`/notifications/${notification.id}/acknowledge`)
          .set('x-test-auth', testAuthHeader('sup-b', 'supervisor'));

        expect(response.status).toBe(200);
        expect(notificationBody(response).acknowledgedBy).toBe(supervisorB.id);
        expect(notificationBody(response).acknowledgedAt).not.toBeNull();

        const [audit] = await getDb().select().from(schema.auditLog);
        expect(audit).toMatchObject({
          action: 'notification.acknowledge',
          entityType: 'notification',
          entityId: notification.id,
          actorUserId: supervisorB.id,
        });
      });

      it('rejects a non-supervisor caller with 403', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        await createTestUser('fam-1', 'family_member', '+254700000003');
        const notification = await createTestNotification(supervisor.id);

        const response = await request(app)
          .post(`/notifications/${notification.id}/acknowledge`)
          .set('x-test-auth', testAuthHeader('fam-1', 'family_member'));

        expect(response.status).toBe(403);
      });

      it('is idempotent: acknowledging twice leaves the original acknowledgedBy untouched', async () => {
        const supervisorA = await createTestUser('sup-a', 'supervisor', '+254700000001');
        await createTestUser('sup-b', 'supervisor', '+254700000002');
        const notification = await createTestNotification(supervisorA.id);

        const first = await request(app)
          .post(`/notifications/${notification.id}/acknowledge`)
          .set('x-test-auth', testAuthHeader('sup-a', 'supervisor'));
        expect(first.status).toBe(200);

        const second = await request(app)
          .post(`/notifications/${notification.id}/acknowledge`)
          .set('x-test-auth', testAuthHeader('sup-b', 'supervisor'));

        expect(second.status).toBe(200);
        expect(notificationBody(second).acknowledgedBy).toBe(supervisorA.id);
        expect(notificationBody(second).acknowledgedAt).toBe(
          notificationBody(first).acknowledgedAt,
        );

        // The no-op second call writes no audit row of its own - only the first ack's.
        expect(await getDb().select().from(schema.auditLog)).toHaveLength(1);
      });

      it('returns 404 for a nonexistent notification', async () => {
        await createTestUser('sup-1', 'supervisor', '+254700000001');

        const response = await request(app)
          .post('/notifications/01a0bfb1-61b8-7260-b9e3-2d549e1bda49/acknowledge')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(404);
      });
    });
  },
);

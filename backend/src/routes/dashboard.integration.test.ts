// GET /dashboard/overview against a real local Postgres, with "now" pinned, since the map's
// colours and the trend's outcomes depend on it. Covers the four visit states, the Nairobi
// calendar day (not the UTC one), the 14-day window, and the attention counts.

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
import { createDashboardRouter, visitState } from './dashboard.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

// 10:30 in Nairobi on 2026-09-26.
const NOW = new Date('2026-09-26T10:30:00+03:00');

function testAuthHeader(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
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
  app.use('/dashboard', createDashboardRouter({ requireAuth, now: () => NOW }));
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ title: 'Internal Server Error', message: String(err) });
    },
  );
  return app;
}

describe('visitState', () => {
  const visit = {
    status: 'scheduled',
    scheduledStart: new Date('2026-09-26T10:00:00+03:00'),
    scheduledEnd: new Date('2026-09-26T11:00:00+03:00'),
    checkinAt: null,
  };

  it('is upcoming before the start, awaiting check-in during, no check-in after', () => {
    expect(visitState(visit, new Date('2026-09-26T09:59:00+03:00'))).toBe('upcoming');
    expect(visitState(visit, new Date('2026-09-26T10:00:00+03:00'))).toBe('awaiting_checkin');
    expect(visitState(visit, new Date('2026-09-26T11:00:00+03:00'))).toBe('awaiting_checkin');
    expect(visitState(visit, new Date('2026-09-26T11:00:01+03:00'))).toBe('no_checkin');
  });

  it('is checked in once there is a check-in, even after the end', () => {
    const checkedIn = { ...visit, checkinAt: new Date('2026-09-26T10:05:00+03:00') };
    expect(visitState(checkedIn, new Date('2026-09-26T12:00:00+03:00'))).toBe('checked_in');
  });

  it('is no check-in once marked missed or investigated, whatever the time', () => {
    const early = new Date('2026-09-26T09:00:00+03:00');
    expect(visitState({ ...visit, status: 'missed' }, early)).toBe('no_checkin');
    expect(visitState({ ...visit, status: 'investigated' }, early)).toBe('no_checkin');
  });
});

interface OverviewBody {
  date: string;
  timeZone: string;
  visits: {
    id: string;
    state: string;
    checkinAt: string | null;
    checkoutAt: string | null;
    caregiver: { fullName: string; phoneNumber: string };
    dependant: { fullName: string; lat: number; lng: number };
  }[];
  trend: { date: string; completed: number; missed: number; cancelled: number; open: number }[];
  attention: {
    missedVisitAlerts: {
      total: number;
      items: { id: string; dependantName: string; caregiverName: string }[];
    };
    flaggedPhotos: number;
    dependantsWithoutPhoto: { total: number; items: { fullName: string }[] };
  };
}

describe.skipIf(!hasTestDb)('GET /dashboard/overview (real Postgres)', () => {
  let app: Express;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await setupTestDb();
    app = buildTestApp();
  });

  beforeEach(async () => {
    await truncateAllTables();
    const db = getDb();
    const [supervisor, caregiverUser] = await db
      .insert(schema.users)
      .values([
        {
          cognitoSub: 'sup',
          fullName: 'Sarah Kimani',
          phoneNumber: '+254700000001',
          role: 'supervisor',
        },
        {
          cognitoSub: 'cg',
          fullName: 'Amina Wanjiru',
          phoneNumber: '+254700000002',
          role: 'caregiver',
        },
      ])
      .returning();
    await db.insert(schema.caregivers).values({ userId: caregiverUser!.id });
    const [withPhoto, withoutPhoto] = await db
      .insert(schema.dependants)
      .values(
        ['Joseph Otieno', 'Wanjiku Kamau'].map((fullName, i) => ({
          fullName,
          dob: '1945-01-01',
          geofenceLat: -1.29 - i / 100,
          geofenceLng: 36.82,
          geofenceRadiusMeters: 20,
          registeredBy: supervisor!.id,
        })),
      )
      .returning();
    await db.insert(schema.biometricEnrollments).values({
      subjectType: 'dependant',
      dependantId: withPhoto!.id,
      s3Key: 'test/photo.jpg',
      imageOrder: 1,
      status: 'active',
      enrolledBy: supervisor!.id,
    });
    await db.insert(schema.biometricEnrollments).values({
      subjectType: 'caregiver',
      caregiverId: caregiverUser!.id,
      s3Key: 'test/flagged.jpg',
      imageOrder: 1,
      status: 'flagged',
      matchedSubjectType: 'caregiver',
      matchedSubjectId: caregiverUser!.id,
      matchedSimilarity: 99,
      enrolledBy: supervisor!.id,
    });

    async function visit(
      name: string,
      start: string,
      end: string,
      options: { status?: string; checkinAt?: string; checkoutAt?: string } = {},
    ) {
      const [row] = await db
        .insert(schema.visitSchedules)
        .values({
          caregiverId: caregiverUser!.id,
          dependantId: withPhoto!.id,
          scheduledStart: new Date(start),
          scheduledEnd: new Date(end),
          status: options.status ?? 'scheduled',
          createdBy: supervisor!.id,
        })
        .returning();
      ids[name] = row!.id;
      if (options.checkinAt) {
        await db.insert(schema.verificationEvents).values({
          visitScheduleId: row!.id,
          checkinAt: new Date(options.checkinAt),
          checkoutAt: options.checkoutAt ? new Date(options.checkoutAt) : null,
        });
      }
    }

    // The day, 2026-09-26 in Nairobi. The first starts on the 25th in UTC.
    await visit('noCheckin', '2026-09-26T00:30:00+03:00', '2026-09-26T01:30:00+03:00');
    await visit('checkedIn', '2026-09-26T08:00:00+03:00', '2026-09-26T09:00:00+03:00', {
      status: 'completed',
      checkinAt: '2026-09-26T08:02:00+03:00',
      checkoutAt: '2026-09-26T08:58:00+03:00',
    });
    await visit('awaiting', '2026-09-26T10:00:00+03:00', '2026-09-26T11:00:00+03:00');
    await visit('upcoming', '2026-09-26T13:00:00+03:00', '2026-09-26T14:00:00+03:00');
    await visit('cancelled', '2026-09-26T15:00:00+03:00', '2026-09-26T16:00:00+03:00', {
      status: 'cancelled',
    });
    // Earlier in the 14 days, and one just before it.
    await visit('pastMissed', '2026-09-13T09:00:00+03:00', '2026-09-13T10:00:00+03:00', {
      status: 'missed',
    });
    await visit('tooOld', '2026-09-12T09:00:00+03:00', '2026-09-12T10:00:00+03:00', {
      status: 'missed',
    });
    // Near the end of the Nairobi day, still inside it.
    await visit('lateEvening', '2026-09-26T23:00:00+03:00', '2026-09-26T23:45:00+03:00');

    await db.insert(schema.notificationLog).values([
      {
        type: 'missed_visit',
        visitScheduleId: ids.pastMissed!,
        recipientUserId: supervisor!.id,
        sentAt: new Date('2026-09-13T10:15:00+03:00'),
      },
      {
        type: 'missed_visit',
        visitScheduleId: ids.tooOld!,
        recipientUserId: supervisor!.id,
        sentAt: new Date('2026-09-12T10:15:00+03:00'),
        acknowledgedAt: new Date('2026-09-12T11:00:00+03:00'),
        acknowledgedBy: supervisor!.id,
      },
    ]);
    ids.withoutPhoto = withoutPhoto!.id;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  async function overview(query = '') {
    return request(app)
      .get(`/dashboard/overview${query}`)
      .set('x-test-auth', testAuthHeader('sup', 'supervisor'));
  }

  it("colours today's visits by where they stand, leaving out cancelled ones", async () => {
    const response = await overview();
    expect(response.status).toBe(200);
    const body = response.body as OverviewBody;
    expect(body.date).toBe('2026-09-26');
    expect(body.timeZone).toBe('Africa/Nairobi');
    expect(body.visits.map((v) => [v.id, v.state])).toEqual([
      [ids.noCheckin, 'no_checkin'],
      [ids.checkedIn, 'checked_in'],
      [ids.awaiting, 'awaiting_checkin'],
      [ids.upcoming, 'upcoming'],
      [ids.lateEvening, 'upcoming'],
    ]);
    const checkedIn = body.visits[1]!;
    expect(checkedIn.checkinAt).toBe('2026-09-26T05:02:00.000Z');
    expect(checkedIn.checkoutAt).toBe('2026-09-26T05:58:00.000Z');
    expect(checkedIn.caregiver).toMatchObject({
      fullName: 'Amina Wanjiru',
      phoneNumber: '+254700000002',
    });
    expect(checkedIn.dependant).toMatchObject({ fullName: 'Joseph Otieno', lat: -1.29 });
  });

  it('counts 14 Nairobi days of outcomes ending on the chosen day', async () => {
    const body = (await overview()).body as OverviewBody;
    expect(body.trend).toHaveLength(14);
    expect(body.trend[0]).toEqual({
      date: '2026-09-13',
      completed: 0,
      missed: 1,
      cancelled: 0,
      open: 0,
    });
    expect(body.trend[13]).toEqual({
      date: '2026-09-26',
      completed: 1,
      missed: 1,
      cancelled: 1,
      open: 3,
    });
    // The 12th is outside the window.
    const total = body.trend.reduce((n, d) => n + d.completed + d.missed + d.cancelled + d.open, 0);
    expect(total).toBe(7);
  });

  it('shows another day when asked', async () => {
    const body = (await overview('?date=2026-09-13')).body as OverviewBody;
    expect(body.visits.map((v) => [v.id, v.state])).toEqual([[ids.pastMissed, 'no_checkin']]);
    expect(body.trend.at(-1)?.date).toBe('2026-09-13');
    expect(body.trend[0]?.date).toBe('2026-08-31');
  });

  it('lists what needs attention', async () => {
    const { attention } = (await overview()).body as OverviewBody;
    expect(attention.missedVisitAlerts.total).toBe(1);
    expect(attention.missedVisitAlerts.items).toEqual([
      expect.objectContaining({ dependantName: 'Joseph Otieno', caregiverName: 'Amina Wanjiru' }),
    ]);
    expect(attention.flaggedPhotos).toBe(1);
    expect(attention.dependantsWithoutPhoto).toEqual({
      total: 1,
      items: [{ id: ids.withoutPhoto, fullName: 'Wanjiku Kamau' }],
    });
  });

  it('rejects a malformed date', async () => {
    expect((await overview('?date=2026-02-30')).status).toBe(400);
    expect((await overview('?date=26-09-2026')).status).toBe(400);
  });

  it('is for supervisors only', async () => {
    for (const role of ['caregiver', 'family_member'] as const) {
      const response = await request(app)
        .get('/dashboard/overview')
        .set('x-test-auth', testAuthHeader('cg', role));
      expect(response.status).toBe(403);
    }
  });
});

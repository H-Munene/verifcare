// GET /dependants/{id}/stats and GET /caregivers/{id}/stats (2026-09-27) against a real local
// Postgres. Both share db/visitStats.ts, so one file seeds one set of visits and checks each
// route's view of it: the 30-day window, the outcome counts (the Overview's own rules), the
// completion rate, the next and last visit, and each route's access rules.

import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CognitoAdmin } from '../auth/cognitoAdmin.js';
import type { AuthenticatedUser, UserRole } from '../auth/verifier.js';
import * as schema from '../db/schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../db/testSupport.js';
import type { VisitStatsResponse } from '../db/visitStats.js';
import { createCaregiversRouter } from './caregivers.js';
import { createDependantsRouter } from './dependants.js';

const hasTestDb = Boolean(getTestDatabaseUrl());
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function auth(sub: string, role: UserRole): string {
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
  const cognitoAdmin: CognitoAdmin = {
    assignRole: vi.fn().mockResolvedValue(undefined),
    createUser: vi.fn().mockResolvedValue('unused-sub'),
  };
  app.use('/dependants', createDependantsRouter({ cognitoAdmin, requireAuth }));
  app.use('/caregivers', createCaregiversRouter({ cognitoAdmin, requireAuth }));
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ title: 'Internal Server Error', message: String(err) });
    },
  );
  return app;
}

describe.skipIf(!hasTestDb)('GET /dependants/{id}/stats, GET /caregivers/{id}/stats', () => {
  let app: Express;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await setupTestDb();
    app = buildTestApp();
  });

  beforeEach(async () => {
    await truncateAllTables();
    const db = getDb();
    const now = Date.now();
    const [supervisor, amina, grace, linked, unlinked] = await db
      .insert(schema.users)
      .values([
        {
          cognitoSub: 'sup',
          fullName: 'Sarah Kimani',
          phoneNumber: '+254700000001',
          role: 'supervisor',
        },
        {
          cognitoSub: 'cg1',
          fullName: 'Amina Wanjiru',
          phoneNumber: '+254700000002',
          role: 'caregiver',
        },
        {
          cognitoSub: 'cg2',
          fullName: 'Grace Achieng',
          phoneNumber: '+254700000003',
          role: 'caregiver',
        },
        {
          cognitoSub: 'fm1',
          fullName: 'Mary Doe',
          phoneNumber: '+254700000004',
          role: 'family_member',
        },
        {
          cognitoSub: 'fm2',
          fullName: 'Tom Other',
          phoneNumber: '+254700000005',
          role: 'family_member',
        },
      ])
      .returning();
    await db.insert(schema.caregivers).values([{ userId: amina!.id }, { userId: grace!.id }]);
    const [john, wanjiku] = await db
      .insert(schema.dependants)
      .values(
        ['John Doe', 'Wanjiku Kamau'].map((fullName, i) => ({
          fullName,
          dob: '1945-01-01',
          geofenceLat: -1.29 - i / 100,
          geofenceLng: 36.82,
          geofenceRadiusMeters: 20,
          registeredBy: supervisor!.id,
        })),
      )
      .returning();
    await db.insert(schema.dependantFamilyMembers).values({
      dependantId: john!.id,
      familyMemberUserId: linked!.id,
      isPrimaryContact: true,
      addedBy: supervisor!.id,
    });
    Object.assign(ids, {
      supervisor: supervisor!.id,
      amina: amina!.id,
      grace: grace!.id,
      john: john!.id,
      wanjiku: wanjiku!.id,
      unlinked: unlinked!.id,
    });

    // John's visits, all with Amina unless noted. Each visit is one hour long.
    const visit = (
      startOffset: number,
      status: string,
      options: { caregiverId?: string; dependantId?: string } = {},
    ) => ({
      caregiverId: options.caregiverId ?? amina!.id,
      dependantId: options.dependantId ?? john!.id,
      scheduledStart: new Date(now + startOffset),
      scheduledEnd: new Date(now + startOffset + HOUR),
      status,
      createdBy: supervisor!.id,
    });
    const visits = await db
      .insert(schema.visitSchedules)
      .values([
        visit(-40 * DAY, 'completed'), // 0: outside the window; the check-in is the oldest
        visit(-10 * DAY, 'completed'), // 1: completed (checked in and out)
        visit(-5 * DAY, 'missed'), // 2: missed
        visit(-3 * DAY, 'scheduled'), // 3: missed by the time rule (end passed, no check-in)
        visit(-2 * DAY, 'cancelled'), // 4: cancelled
        visit(-1 * DAY, 'completed', { caregiverId: grace!.id }), // 5: completed, most recent check-in
        visit(-30 * 60 * 1000, 'in_progress'), // 6: open (checked in, not out)
        visit(2 * DAY, 'scheduled'), // 7: later upcoming visit
        visit(1 * DAY, 'scheduled', { caregiverId: grace!.id }), // 8: the next visit
        visit(12 * HOUR, 'cancelled'), // 9: cancelled, so not the next visit
        visit(-4 * DAY, 'completed', { dependantId: wanjiku!.id }), // 10: another dependant
      ])
      .returning();
    const checkin = (index: number, checkoutAfter: number | null) => {
      const start = visits[index]!.scheduledStart.getTime();
      return {
        visitScheduleId: visits[index]!.id,
        checkinAt: new Date(start + 5 * 60 * 1000),
        checkoutAt: checkoutAfter === null ? null : new Date(start + checkoutAfter),
      };
    };
    await db
      .insert(schema.verificationEvents)
      .values([
        checkin(0, 50 * 60 * 1000),
        checkin(1, 50 * 60 * 1000),
        checkin(5, 55 * 60 * 1000),
        checkin(6, null),
        checkin(10, 50 * 60 * 1000),
      ]);
    ids.nextVisit = visits[8]!.id;
    ids.lastVisit = visits[5]!.id;
    ids.aminaLastVisit = visits[10]!.id;
    ids.aminaNextVisit = visits[7]!.id;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("counts a dependant's last 30 days by outcome, with the next and last visit", async () => {
    const res = await request(app)
      .get(`/dependants/${ids.john}/stats`)
      .set('x-test-auth', auth('sup', 'supervisor'));

    expect(res.status).toBe(200);
    const body = res.body as VisitStatsResponse;
    expect(body.windowDays).toBe(30);
    expect(body.visits).toEqual({ total: 6, completed: 2, missed: 2, cancelled: 1, open: 1 });
    expect(body.completionRate).toBe(0.5);
    expect(body.lastMissedVisitStart).not.toBeNull();
    expect(body.nextVisit?.id).toBe(ids.nextVisit);
    expect(body.nextVisit?.caregiverName).toBe('Grace Achieng');
    // The in-progress visit's check-in is the latest of all.
    expect(body.lastVisit?.checkoutAt).toBeNull();
    expect(body.lastVisit?.caregiverName).toBe('Amina Wanjiru');
  });

  it("counts a caregiver's visits across every dependant they visit", async () => {
    const res = await request(app)
      .get(`/caregivers/${ids.amina}/stats`)
      .set('x-test-auth', auth('sup', 'supervisor'));

    expect(res.status).toBe(200);
    const body = res.body as VisitStatsResponse;
    // John's window minus Grace's visit, plus Wanjiku's.
    expect(body.visits).toEqual({ total: 6, completed: 2, missed: 2, cancelled: 1, open: 1 });
    expect(body.nextVisit?.id).toBe(ids.aminaNextVisit);
    expect(body.nextVisit?.dependantName).toBe('John Doe');
  });

  it('handles a single visit and nothing upcoming', async () => {
    const res = await request(app)
      .get(`/caregivers/${ids.grace}/stats`)
      .set('x-test-auth', auth('sup', 'supervisor'));
    const body = res.body as VisitStatsResponse;
    expect(body.visits.total).toBe(1);

    const single = await request(app)
      .get(`/dependants/${ids.wanjiku}/stats`)
      .set('x-test-auth', auth('sup', 'supervisor'));
    const singleBody = single.body as VisitStatsResponse;
    expect(singleBody.visits).toEqual({ total: 1, completed: 1, missed: 0, cancelled: 0, open: 0 });
    expect(singleBody.completionRate).toBe(1);
    expect(singleBody.nextVisit).toBeNull();
  });

  it('lets a linked family member see the dependant stats, not an unlinked one', async () => {
    const linked = await request(app)
      .get(`/dependants/${ids.john}/stats`)
      .set('x-test-auth', auth('fm1', 'family_member'));
    expect(linked.status).toBe(200);

    const unlinked = await request(app)
      .get(`/dependants/${ids.john}/stats`)
      .set('x-test-auth', auth('fm2', 'family_member'));
    expect(unlinked.status).toBe(403);
  });

  it('keeps caregiver stats supervisor-only and caregivers out of dependant stats', async () => {
    const familyMember = await request(app)
      .get(`/caregivers/${ids.amina}/stats`)
      .set('x-test-auth', auth('fm1', 'family_member'));
    expect(familyMember.status).toBe(403);

    const caregiver = await request(app)
      .get(`/dependants/${ids.john}/stats`)
      .set('x-test-auth', auth('cg1', 'caregiver'));
    expect(caregiver.status).toBe(403);
  });

  it('returns 404 for an unknown id and 400 for a malformed one', async () => {
    const unknown = '00000000-0000-7000-8000-000000000000';
    const supervisor = auth('sup', 'supervisor');
    expect(
      (await request(app).get(`/dependants/${unknown}/stats`).set('x-test-auth', supervisor))
        .status,
    ).toBe(404);
    expect(
      (await request(app).get(`/caregivers/${unknown}/stats`).set('x-test-auth', supervisor))
        .status,
    ).toBe(404);
    expect(
      (await request(app).get('/dependants/not-a-uuid/stats').set('x-test-auth', supervisor))
        .status,
    ).toBe(400);
  });
});

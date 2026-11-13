// The Compliance tab's endpoints and exception resolution against a real local Postgres, with
// "now" pinned, since outcomes, lateness and the default period depend on it. One September of
// visits covers each way a visit can be judged: fully verified, late (16 minutes, not 15),
// checked out outside the radius, missed, cancelled, and checked in with no checkout.

import express, { type Express } from 'express';
import { eq } from 'drizzle-orm';
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
import { createComplianceRouter } from './compliance.js';
import { createVisitResolutionsRouter } from './visitResolutions.js';
import { createVisitSchedulesRouter } from './visitSchedules.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

// Midday in Nairobi on 2026-09-26, so the default period is September 2026.
const NOW = new Date('2026-09-26T12:00:00+03:00');

function testAuthHeader(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

const supervisorAuth = testAuthHeader('sup', 'supervisor');

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
  app.use('/compliance', createComplianceRouter({ requireAuth, now: () => NOW }));
  app.use('/visit-schedules', createVisitResolutionsRouter({ requireAuth, now: () => NOW }));
  app.use('/visit-schedules', createVisitSchedulesRouter({ requireAuth }));
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ title: 'Internal Server Error', message: String(err) });
    },
  );
  return app;
}

// supertest types every body as `any`; each test reads it through the shape it expects.
interface SummaryBody {
  period: { from: string; to: string };
  rows: ({ personName: string; completionRate: number | null } & Record<string, unknown>)[];
  totals: { total: number };
}
interface ExceptionsBody {
  total: number;
  items: {
    visitScheduleId: string;
    kinds: string[];
    latestResolution: { outcome: string } | null;
  }[];
  nextCursor: string | null;
}
interface AuditLogBody {
  items: { actorUserId: string | null; actorName: string | null; createdAt: string }[];
  nextCursor: string | null;
}
interface TermsBody {
  documents: ({ document: string; users: unknown[] } & Record<string, unknown>)[];
}

describe.skipIf(!hasTestDb)('Compliance endpoints (real Postgres)', () => {
  let app: Express;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await setupTestDb();
    app = buildTestApp();
  });

  beforeEach(async () => {
    await truncateAllTables();
    const db = getDb();
    const [supervisor, amina, brian] = await db
      .insert(schema.users)
      .values([
        { cognitoSub: 'sup', fullName: 'Sarah Kimani', role: 'supervisor' },
        {
          cognitoSub: 'amina',
          fullName: 'Amina Wanjiru',
          phoneNumber: '+254700000002',
          role: 'caregiver',
        },
        {
          cognitoSub: 'brian',
          fullName: 'Brian Otieno',
          phoneNumber: '+254700000003',
          role: 'caregiver',
        },
      ])
      .returning();
    ids.supervisor = supervisor!.id;
    ids.amina = amina!.id;
    ids.brian = brian!.id;
    await db.insert(schema.caregivers).values([{ userId: amina!.id }, { userId: brian!.id }]);
    const [joseph, wanjiku] = await db
      .insert(schema.dependants)
      .values(
        ['Joseph Mwangi', 'Wanjiku Kamau'].map((fullName) => ({
          fullName,
          dob: '1945-01-01',
          geofenceLat: -1.29,
          geofenceLng: 36.82,
          geofenceRadiusMeters: 20,
          registeredBy: supervisor!.id,
        })),
      )
      .returning();
    ids.joseph = joseph!.id;
    ids.wanjiku = wanjiku!.id;

    async function visit(
      name: string,
      caregiverId: string,
      dependantId: string,
      start: string,
      status: string,
      event?: Partial<typeof schema.verificationEvents.$inferInsert>,
    ) {
      const scheduledStart = new Date(`${start}:00+03:00`);
      const [row] = await db
        .insert(schema.visitSchedules)
        .values({
          caregiverId,
          dependantId,
          scheduledStart,
          scheduledEnd: new Date(scheduledStart.getTime() + 60 * 60 * 1000),
          status,
          createdBy: supervisor!.id,
        })
        .returning();
      ids[name] = row!.id;
      if (event) {
        await db.insert(schema.verificationEvents).values({ visitScheduleId: row!.id, ...event });
      }
    }
    const at = (time: string) => new Date(`${time}:00+03:00`);

    await visit('verified', amina!.id, joseph!.id, '2026-09-10T09:00', 'completed', {
      checkinAt: at('2026-09-10T09:15'), // exactly the tolerance: on time
      checkoutAt: at('2026-09-10T09:55'),
      checkinMethod: 'qr',
      checkoutDistanceFromGeofenceMeters: 10,
    });
    await visit('lateOutside', amina!.id, joseph!.id, '2026-09-11T09:00', 'completed', {
      checkinAt: at('2026-09-11T09:16'), // a minute past the tolerance: late
      checkoutAt: at('2026-09-11T09:58'),
      checkinMethod: 'qr',
      checkoutDistanceFromGeofenceMeters: 30, // outside the 20 m radius
    });
    await db.insert(schema.verificationAttempts).values({
      visitScheduleId: ids.lateOutside!,
      attemptType: 'geofence',
      passed: false,
      failureReason: 'out_of_range',
    });
    await visit('missed', amina!.id, joseph!.id, '2026-09-12T09:00', 'missed');
    await visit('cancelled', amina!.id, joseph!.id, '2026-09-13T09:00', 'cancelled');
    await visit('noCheckout', brian!.id, wanjiku!.id, '2026-09-20T09:00', 'in_progress', {
      checkinAt: at('2026-09-20T09:05'),
      checkinMethod: 'qr',
    });
    await visit('upcoming', brian!.id, wanjiku!.id, '2026-10-02T09:00', 'scheduled');

    await db.insert(schema.notificationLog).values([
      {
        type: 'missed_visit',
        visitScheduleId: ids.missed!,
        sentAt: at('2026-09-12T10:05'),
        acknowledgedAt: at('2026-09-12T10:15'),
        acknowledgedBy: supervisor!.id,
      },
      { type: 'missed_visit', visitScheduleId: ids.noCheckout!, sentAt: at('2026-09-20T10:05') },
    ]);
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('is supervisor-only', async () => {
    const response = await request(app)
      .get('/compliance/visits')
      .set('x-test-auth', testAuthHeader('amina', 'caregiver'));
    expect(response.status).toBe(403);
  });

  it('rejects a period that runs backwards', async () => {
    const response = await request(app)
      .get('/compliance/visits?from=2026-09-30&to=2026-09-01')
      .set('x-test-auth', supervisorAuth);
    expect(response.status).toBe(400);
  });

  it('summarises each caregiver over the default period (this month)', async () => {
    const response = await request(app)
      .get('/compliance/visits?groupBy=caregiver')
      .set('x-test-auth', supervisorAuth);

    expect(response.status).toBe(200);
    const body = response.body as SummaryBody;
    expect(body.period).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    const amina = body.rows.find((r) => r.personName === 'Amina Wanjiru');
    expect(amina).toMatchObject({
      total: 4,
      completed: 2,
      missed: 1,
      cancelled: 1,
      open: 0,
      fullyVerified: 1,
      late: 1,
      missingCheckout: 0,
      verifiedRate: 0.5,
    });
    expect(amina?.completionRate).toBeCloseTo(2 / 3);
    const brian = body.rows.find((r) => r.personName === 'Brian Otieno');
    expect(brian).toMatchObject({ total: 1, open: 1, missingCheckout: 1, completionRate: null });
    // October's upcoming visit is outside the period.
    expect(body.totals.total).toBe(5);
  });

  it('lists exceptions newest first, paged, with why each is one', async () => {
    const first = await request(app)
      .get('/compliance/exceptions?limit=2')
      .set('x-test-auth', supervisorAuth);
    expect(first.status).toBe(200);
    const firstPage = first.body as ExceptionsBody;
    expect(firstPage.total).toBe(3);
    expect(firstPage.items.map((i) => i.visitScheduleId)).toEqual([ids.noCheckout, ids.missed]);
    expect(firstPage.items[0]?.kinds).toEqual(['missing_checkout']);
    expect(firstPage.items[1]?.kinds).toEqual(['missed']);

    const second = await request(app)
      .get(`/compliance/exceptions?limit=2&cursor=${firstPage.nextCursor ?? ''}`)
      .set('x-test-auth', supervisorAuth);
    const secondPage = second.body as ExceptionsBody;
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]).toMatchObject({
      visitScheduleId: ids.lateOutside,
      kinds: ['failed_check'],
      failedChecks: [{ attemptType: 'geofence', failureReason: 'out_of_range', count: 1 }],
    });
    expect(secondPage.nextCursor).toBeNull();
  });

  it('resolves exceptions: missed becomes investigated, open alerts are acknowledged, all audited', async () => {
    const missed = await request(app)
      .post(`/visit-schedules/${ids.missed!}/resolutions`)
      .set('x-test-auth', supervisorAuth)
      .send({ outcome: 'caregiver_absent', note: '  Amina was unwell and told the family.  ' });
    expect(missed.status).toBe(201);
    expect(missed.body).toMatchObject({
      outcome: 'caregiver_absent',
      note: 'Amina was unwell and told the family.',
      resolvedByName: 'Sarah Kimani',
    });

    const noCheckout = await request(app)
      .post(`/visit-schedules/${ids.noCheckout!}/resolutions`)
      .set('x-test-auth', supervisorAuth)
      .send({ outcome: 'device_or_network_issue', note: 'Phone died before checkout.' });
    expect(noCheckout.status).toBe(201);

    const db = getDb();
    const visits = await db.select().from(schema.visitSchedules);
    const statusOf = (id: string | undefined) => visits.find((v) => v.id === id)?.status;
    expect(statusOf(ids.missed)).toBe('investigated');
    // Checked in, so not a missed visit: its status is left alone.
    expect(statusOf(ids.noCheckout)).toBe('in_progress');

    const [alert] = await db
      .select()
      .from(schema.notificationLog)
      .where(eq(schema.notificationLog.visitScheduleId, ids.noCheckout!));
    expect(alert?.acknowledgedBy).toBe(ids.supervisor);

    const audit = await db.select().from(schema.auditLog);
    expect(audit.map((a) => a.action).sort()).toEqual([
      'notification.acknowledge',
      'visit.resolve',
      'visit.resolve',
      'visit_schedule.update',
    ]);

    const resolved = await request(app)
      .get('/compliance/exceptions?resolved=true')
      .set('x-test-auth', supervisorAuth);
    const resolvedPage = resolved.body as ExceptionsBody;
    expect(resolvedPage.items.map((i) => i.visitScheduleId)).toEqual([ids.noCheckout, ids.missed]);
    expect(resolvedPage.items[1]?.latestResolution?.outcome).toBe('caregiver_absent');

    // The visit's side panel reads the history and why it's an exception from its verification.
    const verification = await request(app)
      .get(`/visit-schedules/${ids.missed!}/verification`)
      .set('x-test-auth', supervisorAuth);
    expect(verification.status).toBe(200);
    expect(verification.body).toMatchObject({
      exceptionKinds: ['missed'],
      resolutions: [{ outcome: 'caregiver_absent', resolvedByName: 'Sarah Kimani' }],
    });
  });

  it('refuses to resolve a visit with nothing to resolve, a blank note, or for a non-supervisor', async () => {
    const clean = await request(app)
      .post(`/visit-schedules/${ids.verified!}/resolutions`)
      .set('x-test-auth', supervisorAuth)
      .send({ outcome: 'other', note: 'Nothing wrong.' });
    expect(clean.status).toBe(409);

    const blank = await request(app)
      .post(`/visit-schedules/${ids.missed!}/resolutions`)
      .set('x-test-auth', supervisorAuth)
      .send({ outcome: 'other', note: '   ' });
    expect(blank.status).toBe(400);

    const caregiver = await request(app)
      .post(`/visit-schedules/${ids.missed!}/resolutions`)
      .set('x-test-auth', testAuthHeader('amina', 'caregiver'))
      .send({ outcome: 'other', note: 'Me.' });
    expect(caregiver.status).toBe(403);

    expect(await getDb().select().from(schema.visitResolutions)).toHaveLength(0);
  });

  it('reports how quickly missed-visit alerts were acknowledged', async () => {
    const response = await request(app)
      .get('/compliance/alerts')
      .set('x-test-auth', supervisorAuth);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      raised: 2,
      acknowledged: 1,
      unacknowledged: 1,
      medianMinutesToAcknowledge: 10,
      p90MinutesToAcknowledge: 10,
      bySupervisor: [{ name: 'Sarah Kimani', acknowledged: 1, medianMinutesToAcknowledge: 10 }],
    });
  });

  it('lists consent per person, with who revoked it and visits booked without it', async () => {
    const db = getDb();
    const granted = (subject: { caregiverId?: string; dependantId?: string }) =>
      schema.consentTypeEnum.enumValues.map((consentType) => ({
        subjectType: subject.caregiverId ? ('caregiver' as const) : ('dependant' as const),
        ...subject,
        consentType,
        grantedBy: ids.supervisor!,
      }));
    await db
      .insert(schema.consentRecords)
      .values([
        ...granted({ caregiverId: ids.amina! }),
        ...granted({ caregiverId: ids.brian! }),
        ...granted({ dependantId: ids.joseph! }),
        ...granted({ dependantId: ids.wanjiku! }),
      ]);
    await db
      .update(schema.consentRecords)
      .set({ revokedAt: NOW, revokedBy: ids.supervisor! })
      .where(eq(schema.consentRecords.dependantId, ids.wanjiku!));

    const response = await request(app)
      .get('/compliance/consents?status=missing')
      .set('x-test-auth', supervisorAuth);
    expect(response.status).toBe(200);
    const { items } = response.body as { items: unknown[] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: 'Wanjiku Kamau',
      subjectType: 'dependant',
      upcomingVisitsWithoutConsent: 1,
      consents: { location_verification: { status: 'revoked', revokedByName: 'Sarah Kimani' } },
    });
  });

  it('reports caregiver performance from the same visit records as the other reports', async () => {
    const response = await request(app)
      .get('/compliance/caregiver-performance?from=2026-09-01&to=2026-09-30')
      .set('x-test-auth', supervisorAuth);

    expect(response.status).toBe(200);
    const { items } = response.body as {
      items: { caregiverName: string; completed: number; missed: number; assigned: number }[];
    };
    expect(items.map((row) => row.caregiverName)).toEqual(['Amina Wanjiru', 'Brian Otieno']);
    expect(items[0]).toMatchObject({ assigned: 3, completed: 2, missed: 1 });
  });

  it('exports caregiver performance as CSV and logs the export', async () => {
    const response = await request(app)
      .get('/compliance/exports/caregiver-performance?from=2026-09-01&to=2026-09-30')
      .set('x-test-auth', supervisorAuth);

    expect(response.status).toBe(200);
    expect(response.text).toContain('Amina Wanjiru');
    const audits = await getDb()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'compliance.export'));
    expect(audits[0]?.metadata).toMatchObject({ report: 'caregiver-performance' });
  });

  it('keeps caregiver performance from non-supervisors', async () => {
    const response = await request(app)
      .get('/compliance/caregiver-performance')
      .set('x-test-auth', testAuthHeader('someone', 'caregiver'));

    expect(response.status).toBe(403);
  });

  it('reports who has accepted the current terms', async () => {
    const db = getDb();
    await db.insert(schema.termsAcceptances).values([
      { userId: ids.amina!, document: 'caregiver', version: '4' },
      { userId: ids.brian!, document: 'caregiver', version: '1' },
    ]);
    const response = await request(app).get('/compliance/terms').set('x-test-auth', supervisorAuth);
    const caregiverDoc = (response.body as TermsBody).documents.find(
      (d) => d.document === 'caregiver',
    );
    expect(caregiverDoc).toMatchObject({ currentVersion: '4', activeUsers: 2, acceptedCurrent: 1 });
    expect(caregiverDoc?.users[0]).toMatchObject({
      name: 'Brian Otieno',
      acceptedCurrent: false,
      lastAcceptedVersion: '1',
    });
  });

  it('pages the audit log newest first with who did it', async () => {
    const db = getDb();
    await db.insert(schema.auditLog).values(
      ['2026-09-05T09:00', '2026-09-06T09:00', '2026-09-07T09:00'].map((time, i) => ({
        actorUserId: i === 0 ? null : ids.supervisor!,
        action: 'visit_schedule.update',
        entityType: 'visit_schedule',
        entityId: ids.verified!,
        createdAt: new Date(`${time}:00+03:00`),
      })),
    );
    const first = await request(app)
      .get('/compliance/audit-log?limit=2')
      .set('x-test-auth', supervisorAuth);
    expect(first.status).toBe(200);
    const firstPage = first.body as AuditLogBody;
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.items[0]?.actorName).toBe('Sarah Kimani');
    expect(new Date(firstPage.items[0]?.createdAt ?? '').getUTCDate()).toBe(7);

    const second = await request(app)
      .get(`/compliance/audit-log?limit=2&cursor=${firstPage.nextCursor ?? ''}`)
      .set('x-test-auth', supervisorAuth);
    const secondPage = second.body as AuditLogBody;
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.actorUserId).toBeNull();
    expect(secondPage.nextCursor).toBeNull();
  });

  it('exports visits as CSV, one row per visit, and audits the export', async () => {
    const response = await request(app)
      .get('/compliance/exports/visits')
      .set('x-test-auth', supervisorAuth);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/csv/);
    expect(response.headers['content-disposition']).toContain(
      'mzazi-care-visits-2026-09-01-to-2026-09-30.csv',
    );
    const lines = response.text
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(lines[0]).toMatch(/^Visit ID,Scheduled start \(Nairobi\)/);
    expect(lines).toHaveLength(6);
    expect(lines.find((l) => l.startsWith(ids.verified!))).toContain('2026-09-10 09:00');

    const [entry] = await getDb().select().from(schema.auditLog);
    expect(entry).toMatchObject({
      actorUserId: ids.supervisor,
      action: 'compliance.export',
      entityType: 'compliance_report',
      entityId: null,
      metadata: { report: 'visits', from: '2026-09-01', to: '2026-09-30', rows: 5 },
    });
  });

  it('exports the per-caregiver summary with a totals row', async () => {
    const response = await request(app)
      .get('/compliance/exports/visit-summary')
      .set('x-test-auth', supervisorAuth);
    const lines = response.text.trimEnd().split('\r\n');
    expect(lines.at(-1)).toMatch(/^All,5,2,1,0,1,1,67%,1,50%,1,1,0$/);
  });
});

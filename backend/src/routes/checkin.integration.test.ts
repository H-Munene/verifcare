// Integration tests for POST /visit-schedules/{visitScheduleId}/checkin/geofence (HEZ-33) against
// a real local Postgres - see users.integration.test.ts's header comment for why (real
// upsert/append-only-trigger behavior, not a faked query builder) and for the test-auth-header
// pattern used here too.

import { and, eq } from 'drizzle-orm';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthenticatedUser, UserRole } from '../auth/verifier.js';
import { hashSessionToken } from '../auth/sessionToken.js';
import * as schema from '../db/schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../db/testSupport.js';
import { createCheckinRouter } from './checkin.js';
import { createCheckinCodeRouter } from './checkinCode.js';
import { createCheckinOverridesRouter } from './checkinOverrides.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

// Nairobi CBD-ish coordinates, arbitrary but realistic for this project's Kenya context.
const GEOFENCE_LAT = -1.286389;
const GEOFENCE_LNG = 36.817223;
const GEOFENCE_RADIUS_METERS = 100;
// ~30m north of the geofence center - inside a 100m radius, negligible east/west drift.
const NEARBY_LAT = GEOFENCE_LAT + 0.00027;
const NEARBY_LNG = GEOFENCE_LNG;
// ~2km away - well outside any reasonable geofence radius.
const FAR_LAT = GEOFENCE_LAT + 0.018;
const FAR_LNG = GEOFENCE_LNG;

function testAuthHeader(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

interface GeofenceResultBody {
  sessionToken: string;
  distanceFromGeofenceMeters: number;
  expiresAt: string;
}
interface ProblemBody {
  title: string;
  detail?: string;
}
function resultBody(response: request.Response): GeofenceResultBody {
  return response.body as GeofenceResultBody;
}
function problemBody(response: request.Response): ProblemBody {
  return response.body as ProblemBody;
}

function buildTestApp(geofenceAccuracyThresholdMeters = 20, sessionTokenTtlSeconds = 600): Express {
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

  app.use(
    '/visit-schedules',
    createCheckinCodeRouter({
      requireAuth,
      qrTokenTtlSeconds: 60,
    }),
  );
  app.use(
    '/visit-schedules',
    createCheckinRouter({
      requireAuth,
      geofenceAccuracyThresholdMeters,
      sessionTokenTtlSeconds,
    }),
  );
  app.use('/checkin-overrides', createCheckinOverridesRouter({ requireAuth }));
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
      geofenceLat: GEOFENCE_LAT,
      geofenceLng: GEOFENCE_LNG,
      geofenceRadiusMeters: GEOFENCE_RADIUS_METERS,
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
  status: 'scheduled' | 'in_progress' = 'scheduled',
  scheduledStart = new Date('2026-10-01T09:00:00Z'),
): Promise<typeof schema.visitSchedules.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.visitSchedules)
    .values({
      caregiverId,
      dependantId,
      scheduledStart,
      scheduledEnd: new Date(scheduledStart.getTime() + 3_600_000),
      status,
      createdBy: createdById,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test visit.');
  }
  return row;
}

function geofencePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gpsLat: NEARBY_LAT,
    gpsLng: NEARBY_LNG,
    accuracyMeters: 10,
    isMockLocation: false,
    ...overrides,
  };
}

async function linkFamilyMember(
  dependantId: string,
  familyMemberUserId: string,
  addedBy: string,
): Promise<void> {
  await getDb()
    .insert(schema.dependantFamilyMembers)
    .values({ dependantId, familyMemberUserId, isPrimaryContact: true, addedBy });
}

async function passGeofenceAndGetSessionToken(
  app: Express,
  sub: string,
  visitScheduleId: string,
): Promise<string> {
  const response = await request(app)
    .post(`/visit-schedules/${visitScheduleId}/checkin/geofence`)
    .set('x-test-auth', testAuthHeader(sub, 'caregiver'))
    .send(geofencePayload());
  return resultBody(response).sessionToken;
}

describe.skipIf(!hasTestDb)(
  'POST /visit-schedules/{visitScheduleId}/checkin/geofence (real Postgres)',
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

    it('passes for a nearby, accurate, non-mock location and issues a session token', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/geofence`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .send(geofencePayload());

      expect(response.status).toBe(200);
      const body = resultBody(response);
      expect(body.sessionToken).toBeTruthy();
      expect(body.distanceFromGeofenceMeters).toBeLessThan(GEOFENCE_RADIUS_METERS);
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const db = getDb();
      const [event] = await db
        .select()
        .from(schema.verificationEvents)
        .where(eq(schema.verificationEvents.visitScheduleId, visit.id));
      expect(event?.sessionTokenHash).toBe(hashSessionToken(body.sessionToken));
      expect(event?.checkinAt).toBeNull();

      const attempts = await db
        .select()
        .from(schema.verificationAttempts)
        .where(eq(schema.verificationAttempts.visitScheduleId, visit.id));
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ attemptType: 'geofence', passed: true });
    });

    it('rejects a location outside the geofence with 422 and no session token, but still logs the attempt', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/geofence`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .send(geofencePayload({ gpsLat: FAR_LAT, gpsLng: FAR_LNG }));

      expect(response.status).toBe(422);
      expect(problemBody(response).detail).toMatch(/geofence/i);
      expect((problemBody(response) as { failureReason?: string }).failureReason).toBe(
        'out_of_range',
      );

      const db = getDb();
      const [event] = await db
        .select()
        .from(schema.verificationEvents)
        .where(eq(schema.verificationEvents.visitScheduleId, visit.id));
      expect(event).toBeUndefined();

      const attempts = await db
        .select()
        .from(schema.verificationAttempts)
        .where(eq(schema.verificationAttempts.visitScheduleId, visit.id));
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ passed: false, failureReason: 'out_of_range' });
    });

    it('rejects insufficient GPS accuracy with 422', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/geofence`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .send(geofencePayload({ accuracyMeters: 21 }));

      expect(response.status).toBe(422);
      expect((problemBody(response) as { failureReason?: string }).failureReason).toBe(
        'insufficient_accuracy',
      );

      const db = getDb();
      const attempts = await db
        .select()
        .from(schema.verificationAttempts)
        .where(eq(schema.verificationAttempts.visitScheduleId, visit.id));
      expect(attempts[0]).toMatchObject({ passed: false, failureReason: 'insufficient_accuracy' });
    });

    it('always rejects a mock-location report, even from an otherwise-valid nearby fix', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/geofence`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .send(geofencePayload({ isMockLocation: true }));

      expect(response.status).toBe(422);
      expect((problemBody(response) as { failureReason?: string }).failureReason).toBe(
        'mock_location_detected',
      );

      const db = getDb();
      const attempts = await db
        .select()
        .from(schema.verificationAttempts)
        .where(eq(schema.verificationAttempts.visitScheduleId, visit.id));
      expect(attempts[0]).toMatchObject({
        passed: false,
        failureReason: 'mock_location_detected',
      });
    });

    it('rejects a caregiver checking in to a visit assigned to someone else with 403', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiverA = await createTestCaregiver('cg-a', '+254700000002');
      await createTestCaregiver('cg-b', '+254700000003');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiverA.userId, dependant.id, supervisor.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/geofence`)
        .set('x-test-auth', testAuthHeader('cg-b', 'caregiver'))
        .send(geofencePayload());

      expect(response.status).toBe(403);
    });

    it('rejects a supervisor caller with 403 - no supervisor override', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/geofence`)
        .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
        .send(geofencePayload());

      expect(response.status).toBe(403);
    });

    it('rejects a visit that is not in scheduled status with 409', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(
        caregiver.userId,
        dependant.id,
        supervisor.id,
        'in_progress',
      );

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/geofence`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .send(geofencePayload());

      expect(response.status).toBe(409);
    });

    it('returns 404 for a nonexistent visit', async () => {
      await createTestCaregiver('cg-1', '+254700000002');

      const response = await request(app)
        .post('/visit-schedules/00000000-0000-0000-0000-000000000000/checkin/geofence')
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .send(geofencePayload());

      expect(response.status).toBe(404);
    });

    it('re-issuing a passing check-in invalidates the previous session token (upsert, not append)', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

      const first = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/geofence`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .send(geofencePayload());
      const second = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/geofence`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .send(geofencePayload());

      expect(resultBody(first).sessionToken).not.toBe(resultBody(second).sessionToken);

      const db = getDb();
      const rows = await db
        .select()
        .from(schema.verificationEvents)
        .where(eq(schema.verificationEvents.visitScheduleId, visit.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.sessionTokenHash).toBe(hashSessionToken(resultBody(second).sessionToken));

      const attempts = await db
        .select()
        .from(schema.verificationAttempts)
        .where(
          and(
            eq(schema.verificationAttempts.visitScheduleId, visit.id),
            eq(schema.verificationAttempts.passed, true),
          ),
        );
      expect(attempts).toHaveLength(2);
    });

    it('rejects insufficient accuracy even when a stricter threshold is configured', async () => {
      app = buildTestApp(5, 600);
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/geofence`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .send(geofencePayload({ accuracyMeters: 10 }));

      expect(response.status).toBe(422);
    });
  },
);

describe.skipIf(!hasTestDb)('GET .../checkin/context (real Postgres)', () => {
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

  it("returns the dependant's display name, address, and geofence for the assigned caregiver", async () => {
    const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
    const caregiver = await createTestCaregiver('cg-1', '+254700000002');
    const dependant = await createTestDependant(supervisor.id);
    const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

    const response = await request(app)
      .get(`/visit-schedules/${visit.id}/checkin/context`)
      .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      dependantDisplayName: dependant.fullName,
      dependantHomeAddressText: dependant.homeAddressText,
      geofenceLat: GEOFENCE_LAT,
      geofenceLng: GEOFENCE_LNG,
      geofenceRadiusMeters: GEOFENCE_RADIUS_METERS,
    });
  });

  it('does not require a check-in session token, unlike every route past the geofence step', async () => {
    const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
    const caregiver = await createTestCaregiver('cg-1', '+254700000002');
    const dependant = await createTestDependant(supervisor.id);
    const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

    const response = await request(app)
      .get(`/visit-schedules/${visit.id}/checkin/context`)
      .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

    expect(response.status).toBe(200);
  });

  it("403s a caregiver requesting another caregiver's visit", async () => {
    const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
    const caregiver = await createTestCaregiver('cg-1', '+254700000002');
    await createTestCaregiver('cg-2', '+254700000003');
    const dependant = await createTestDependant(supervisor.id);
    const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);

    const response = await request(app)
      .get(`/visit-schedules/${visit.id}/checkin/context`)
      .set('x-test-auth', testAuthHeader('cg-2', 'caregiver'));

    expect(response.status).toBe(403);
  });

  it('409s once the visit has moved past scheduled', async () => {
    const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
    const caregiver = await createTestCaregiver('cg-1', '+254700000002');
    const dependant = await createTestDependant(supervisor.id);
    const visit = await createTestVisit(
      caregiver.userId,
      dependant.id,
      supervisor.id,
      'in_progress',
    );

    const response = await request(app)
      .get(`/visit-schedules/${visit.id}/checkin/context`)
      .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

    expect(response.status).toBe(409);
  });

  it('404s an unknown visit', async () => {
    await createTestUser('sup-1', 'supervisor', '+254700000001');
    await createTestCaregiver('cg-1', '+254700000002');

    const response = await request(app)
      .get('/visit-schedules/00000000-0000-0000-0000-000000000000/checkin/context')
      .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'));

    expect(response.status).toBe(404);
  });
});

describe.skipIf(!hasTestDb)('QR check-in (real Postgres)', () => {
  let app: Express;
  let visitId: string;
  let dependantId: string;
  const caregiverAuth = testAuthHeader('cg-1', 'caregiver');
  const familyAuth = testAuthHeader('fam-1', 'family_member');

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    app = buildTestApp();
    const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
    const caregiver = await createTestCaregiver('cg-1', '+254700000002');
    const dependant = await createTestDependant(supervisor.id);
    dependantId = dependant.id;
    const family = await createTestUser('fam-1', 'family_member', '+254700000003');
    await linkFamilyMember(dependant.id, family.id, supervisor.id);
    visitId = (await createTestVisit(caregiver.userId, dependant.id, supervisor.id)).id;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  const issueCode = (id = visitId, auth = familyAuth, position = geofencePayload()) =>
    request(app).post(`/visit-schedules/${id}/checkin/qr`).set('x-test-auth', auth).send(position);
  const tokenOf = (response: request.Response) => (response.body as { token: string }).token;
  const scan = (sessionToken: string, token: string, id = visitId, auth = caregiverAuth) =>
    request(app)
      .post(`/visit-schedules/${id}/checkin/qr-scan`)
      .set('x-test-auth', auth)
      .set('x-checkin-session-token', sessionToken)
      .send({ token });
  const failureReason = (response: request.Response) =>
    (response.body as { failureReason?: string }).failureReason;
  const visitRow = async (id = visitId) => {
    const [row] = await getDb()
      .select()
      .from(schema.visitSchedules)
      .where(eq(schema.visitSchedules.id, id));
    return row;
  };

  describe('issuing a code', () => {
    it('gives a linked family member at the home a code naming the caregiver, storing only a hash', async () => {
      const response = await issueCode();

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ caregiverDisplayName: 'User cg-1' });
      const [code] = await getDb().select().from(schema.checkinQrTokens);
      expect(code?.tokenHash).toBe(hashSessionToken(tokenOf(response)));
      expect(code?.tokenHash).not.toBe(tokenOf(response));
      expect(code?.expiresAt.getTime()).toBe((code?.issuedAt.getTime() ?? 0) + 60_000);
    });

    it('gives a code with 6 digits wherever the family phone is, and records no location', async () => {
      // An older app still sends a position (here far from the home); a newer one sends nothing.
      const away = await issueCode(
        visitId,
        familyAuth,
        geofencePayload({ gpsLat: FAR_LAT, gpsLng: FAR_LNG }),
      );
      const noPosition = await issueCode(visitId, familyAuth, {});

      for (const response of [away, noPosition]) {
        expect(response.status).toBe(201);
        expect((response.body as { code: string }).code).toMatch(/^\d{6}$/);
      }
      const codes = await getDb().select().from(schema.checkinQrTokens);
      expect(codes.map((code) => code.distanceFromGeofenceMeters)).toEqual([null, null]);
      expect(
        await getDb()
          .select()
          .from(schema.verificationAttempts)
          .where(eq(schema.verificationAttempts.attemptType, 'family_location')),
      ).toHaveLength(0);
    });

    it("refuses a family member who isn't linked to this dependant", async () => {
      await createTestUser('fam-2', 'family_member', '+254700000004');

      const response = await issueCode(visitId, testAuthHeader('fam-2', 'family_member'));

      expect(response.status).toBe(403);
      expect(await getDb().select().from(schema.checkinQrTokens)).toHaveLength(0);
    });

    it('refuses other roles', async () => {
      expect((await issueCode(visitId, caregiverAuth)).status).toBe(403);
      expect((await issueCode(visitId, testAuthHeader('sup-1', 'supervisor'))).status).toBe(403);
    });

    it('refuses a visit no longer awaiting check-in', async () => {
      await getDb().update(schema.visitSchedules).set({ status: 'cancelled' });

      expect((await issueCode()).status).toBe(409);
    });

    it('returns 404 for an unknown visit', async () => {
      expect((await issueCode('00000000-0000-0000-0000-000000000000')).status).toBe(404);
    });
  });

  describe('scanning a code', () => {
    it('starts the visit and records which family member confirmed it', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const code = await issueCode();

      const response = await scan(session, tokenOf(code));

      expect(response.status).toBe(200);
      expect((await visitRow())?.status).toBe('in_progress');
      const [event] = await getDb().select().from(schema.verificationEvents);
      expect(event?.checkinAt).not.toBeNull();
      expect(event?.checkinMethod).toBe('qr');
      expect(event?.familyDistanceFromGeofenceMeters).toBeNull();
      const [family] = await getDb()
        .select()
        .from(schema.users)
        .where(eq(schema.users.cognitoSub, 'fam-1'));
      expect(event?.qrFamilyMemberUserId).toBe(family?.id);
      const audit = await getDb()
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'visit.checkin'));
      expect(audit).toHaveLength(1);
    });

    it('needs the session token from the geofence step', async () => {
      const code = await issueCode();

      const response = await request(app)
        .post(`/visit-schedules/${visitId}/checkin/qr-scan`)
        .set('x-test-auth', caregiverAuth)
        .send({ token: tokenOf(code) });

      expect(response.status).toBe(401);
      expect((await visitRow())?.status).toBe('scheduled');
    });

    it('refuses a code that has already been used', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const token = tokenOf(await issueCode());
      await scan(session, token);
      await getDb().update(schema.visitSchedules).set({ status: 'scheduled' });

      const replay = await scan(session, token);

      expect(replay.status).toBe(422);
      expect(failureReason(replay)).toBe('used_qr');
    });

    it('lets only one of two simultaneous scans succeed', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const token = tokenOf(await issueCode());

      const results = await Promise.all([scan(session, token), scan(session, token)]);

      // The loser sees either a used code (422) or a visit already under way (409).
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409 || r.status === 422)).toHaveLength(1);
    });

    it('refuses an expired code and logs the failure', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const token = tokenOf(await issueCode());
      await getDb()
        .update(schema.checkinQrTokens)
        .set({
          issuedAt: new Date(Date.now() - 120_000),
          expiresAt: new Date(Date.now() - 60_000),
        });

      const response = await scan(session, token);

      expect(response.status).toBe(422);
      expect(failureReason(response)).toBe('expired_qr');
      expect((await visitRow())?.status).toBe('scheduled');
      const attempts = await getDb()
        .select()
        .from(schema.verificationAttempts)
        .where(
          and(
            eq(schema.verificationAttempts.attemptType, 'qr_scan'),
            eq(schema.verificationAttempts.passed, false),
          ),
        );
      expect(attempts).toHaveLength(1);
    });

    it("refuses a code issued for another visit, so it can't be used at another home", async () => {
      const supervisor = await createTestUser('sup-2', 'supervisor', '+254700000005');
      const [caregiver] = await getDb().select().from(schema.caregivers);
      const otherVisit = await createTestVisit(
        caregiver!.userId,
        dependantId,
        supervisor.id,
        'scheduled',
        new Date('2026-10-02T09:00:00Z'),
      );
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const codeForOther = await issueCode(otherVisit.id);

      const response = await scan(session, tokenOf(codeForOther));

      expect(response.status).toBe(422);
      expect(failureReason(response)).toBe('invalid_qr');
    });

    it('refuses a value that is not a code at all', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);

      const response = await scan(session, 'https://example.com/not-a-code');

      expect(failureReason(response)).toBe('invalid_qr');
    });

    it("refuses another caregiver scanning for someone else's visit", async () => {
      await createTestCaregiver('cg-2', '+254700000006');
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const token = tokenOf(await issueCode());

      const response = await scan(session, token, visitId, testAuthHeader('cg-2', 'caregiver'));

      expect(response.status).toBe(403);
    });
  });

  describe('typing a code', () => {
    const type = (session: string | null, code: string) => {
      const req = request(app)
        .post(`/visit-schedules/${visitId}/checkin/code`)
        .set('x-test-auth', caregiverAuth);
      if (session) req.set('x-checkin-session-token', session);
      return req.send({ code });
    };
    const digitsOf = (response: request.Response) => (response.body as { code: string }).code;
    const wrongFor = (digits: string) => String((Number(digits) + 1) % 1_000_000).padStart(6, '0');

    it('starts the visit with the 6 digits under the check-in code', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const digits = digitsOf(await issueCode());

      const response = await type(session, digits);

      expect(response.status).toBe(200);
      expect((await visitRow())?.status).toBe('in_progress');
      const [event] = await getDb().select().from(schema.verificationEvents);
      expect(event?.checkinMethod).toBe('code');
      const [attempt] = await getDb()
        .select()
        .from(schema.verificationAttempts)
        .where(eq(schema.verificationAttempts.attemptType, 'checkin_code'));
      expect(attempt?.passed).toBe(true);
    });

    it('refuses wrong digits, logging the try and saying how many are left', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const digits = digitsOf(await issueCode());

      const response = await type(session, wrongFor(digits));

      expect(response.status).toBe(422);
      expect(failureReason(response)).toBe('invalid_code');
      expect((response.body as { detail: string }).detail).toContain('4 tries left');
      expect((await visitRow())?.status).toBe('scheduled');
    });

    it('refuses digits that were already used', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const digits = digitsOf(await issueCode());
      await type(session, digits);
      await getDb().update(schema.visitSchedules).set({ status: 'scheduled' });

      const replay = await type(session, digits);

      expect(failureReason(replay)).toBe('used_code');
    });

    it('stops accepting typed codes after 5 wrong ones', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const digits = digitsOf(await issueCode());
      for (let i = 0; i < 5; i++) {
        await type(session, wrongFor(digits));
      }

      const response = await type(session, digits);

      expect(response.status).toBe(429);
      expect((await visitRow())?.status).toBe('scheduled');
    });

    it('needs the session token from the geofence step', async () => {
      const digits = digitsOf(await issueCode());

      expect((await type(null, digits)).status).toBe(401);
    });
  });

  describe('supervisor override when no family member is present', () => {
    const supervisorAuth = testAuthHeader('sup-1', 'supervisor');
    const requestOverride = (session: string, body: Record<string, unknown>) =>
      request(app)
        .post(`/visit-schedules/${visitId}/checkin/override`)
        .set('x-test-auth', caregiverAuth)
        .set('x-checkin-session-token', session)
        .send(body);
    const idOf = (response: request.Response) => (response.body as { id: string }).id;
    const decide = (id: string, decision: 'approve' | 'deny', auth = supervisorAuth) =>
      request(app)
        .post(`/checkin-overrides/${id}/${decision}`)
        .set('x-test-auth', auth)
        .send({ note: 'Confirmed by phone with the family.' });
    const poll = () =>
      request(app)
        .get(`/visit-schedules/${visitId}/checkin/override`)
        .set('x-test-auth', caregiverAuth);

    it('queues a request and raises a shared alert', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);

      const response = await requestOverride(session, { reason: 'no_family_member_present' });

      expect(response.status).toBe(201);
      const alerts = await getDb().select().from(schema.notificationLog);
      expect(alerts).toMatchObject([{ type: 'checkin_override', recipientUserId: null }]);
      const list = await request(app).get('/checkin-overrides').set('x-test-auth', supervisorAuth);
      expect((list.body as { items: unknown[] }).items).toMatchObject([
        { dependantName: 'Test Dependant', caregiverName: 'User cg-1', status: 'pending' },
      ]);
    });

    it('needs the caregiver to have passed the geofence', async () => {
      const response = await request(app)
        .post(`/visit-schedules/${visitId}/checkin/override`)
        .set('x-test-auth', caregiverAuth)
        .send({ reason: 'no_family_member_present' });

      expect(response.status).toBe(401);
    });

    it("needs a note when the reason is 'other'", async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);

      expect((await requestOverride(session, { reason: 'other' })).status).toBe(400);
    });

    it('allows only one open request per visit', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      await requestOverride(session, { reason: 'network_problem' });

      const second = await requestOverride(session, { reason: 'network_problem' });

      expect(second.status).toBe(409);
    });

    it('starts the visit on approval, marked as an override, and answers the alert', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const id = idOf(await requestOverride(session, { reason: 'no_family_member_present' }));

      const response = await decide(id, 'approve');

      expect(response.status).toBe(200);
      expect((await visitRow())?.status).toBe('in_progress');
      const [event] = await getDb().select().from(schema.verificationEvents);
      expect(event?.checkinMethod).toBe('supervisor_override');
      expect(event?.checkinAt).not.toBeNull();
      const [alert] = await getDb().select().from(schema.notificationLog);
      expect(alert?.acknowledgedAt).not.toBeNull();
      const polled = await poll();
      expect(polled.status).toBe(200);
      expect(polled.body).toMatchObject({ status: 'approved' });
    });

    it('leaves the visit waiting on denial, and lets the caregiver ask again', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const id = idOf(await requestOverride(session, { reason: 'network_problem' }));

      await decide(id, 'deny');

      expect((await visitRow())?.status).toBe('scheduled');
      expect((await poll()).body).toMatchObject({ status: 'denied' });
      expect((await requestOverride(session, { reason: 'network_problem' })).status).toBe(201);
    });

    it('needs a decision note', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const id = idOf(await requestOverride(session, { reason: 'network_problem' }));

      const response = await request(app)
        .post(`/checkin-overrides/${id}/approve`)
        .set('x-test-auth', supervisorAuth)
        .send({});

      expect(response.status).toBe(400);
    });

    it('only lets a supervisor decide, and only once', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const id = idOf(await requestOverride(session, { reason: 'network_problem' }));

      expect((await decide(id, 'approve', caregiverAuth)).status).toBe(403);
      expect((await decide(id, 'approve')).status).toBe(200);
      expect((await decide(id, 'deny')).status).toBe(409);
    });

    it('refuses approval once the visit has moved on, keeping the request open to deny', async () => {
      const session = await passGeofenceAndGetSessionToken(app, 'cg-1', visitId);
      const id = idOf(await requestOverride(session, { reason: 'network_problem' }));
      await getDb().update(schema.visitSchedules).set({ status: 'missed' });

      expect((await decide(id, 'approve')).status).toBe(409);
      expect((await decide(id, 'deny')).status).toBe(200);
    });

    it('returns 404 from the poll when nothing was requested', async () => {
      expect((await poll()).status).toBe(404);
    });
  });
});

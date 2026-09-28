// Integration tests for POST /visit-schedules/{visitScheduleId}/checkin/geofence (HEZ-33) against
// a real local Postgres - see users.integration.test.ts's header comment for why (real
// upsert/append-only-trigger behavior, not a faked query builder) and for the test-auth-header
// pattern used here too.

import { and, eq } from 'drizzle-orm';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, UserRole } from '../auth/verifier.js';
import { hashSessionToken } from '../auth/sessionToken.js';
import type { CheckinFrameStorage } from '../db/checkinFrameStorage.js';
import type { CheckinPhotoValidator } from '../db/checkinLiveness.js';
import type { FaceMatcher } from '../db/faceMatch.js';
import * as schema from '../db/schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../db/testSupport.js';
import { createCheckinRouter } from './checkin.js';

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

interface UploadUrlBody {
  uploadUrl: string;
  s3Key: string;
  expiresAt: string;
}
function uploadUrlBody(response: request.Response): UploadUrlBody {
  return response.body as UploadUrlBody;
}

function fakePhotoValidator(): CheckinPhotoValidator {
  return {
    validatePhoto: vi.fn().mockResolvedValue({ ok: true }),
  };
}
function fakeFaceMatcher(): FaceMatcher {
  return {
    compareAgainstCandidates: vi
      .fn()
      .mockResolvedValue({ matched: true, similarity: 95, matchedS3Key: 'enrolled.jpg' }),
  };
}
function fakeFrameStorage(): CheckinFrameStorage {
  return {
    createUploadUrl: vi.fn().mockResolvedValue({
      uploadUrl: 'https://example.com/upload',
      s3Key: 'fake-frame-key.jpg',
      expiresAt: new Date(Date.now() + 300_000),
    }),
    objectExists: vi.fn().mockResolvedValue(true),
    deleteObjects: vi.fn().mockResolvedValue(undefined),
  };
}

interface LivenessFakes {
  photoValidator?: CheckinPhotoValidator;
  faceMatcher?: FaceMatcher;
  frameStorage?: CheckinFrameStorage;
}

function buildTestApp(
  geofenceAccuracyThresholdMeters = 20,
  sessionTokenTtlSeconds = 600,
  livenessFakes: LivenessFakes = {},
  coPresenceWindowSeconds = 120,
): Express {
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
    createCheckinRouter({
      requireAuth,
      geofenceAccuracyThresholdMeters,
      sessionTokenTtlSeconds,
      livenessFramesBucketName: 'test-liveness-frames-bucket',
      biometricEnrollmentsBucketName: 'test-biometric-enrollments-bucket',
      livenessMatchThresholdPercent: 80,
      photoValidator: livenessFakes.photoValidator ?? fakePhotoValidator(),
      faceMatcher: livenessFakes.faceMatcher ?? fakeFaceMatcher(),
      frameStorage: livenessFakes.frameStorage ?? fakeFrameStorage(),
      coPresenceWindowSeconds,
    }),
  );
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
): Promise<typeof schema.visitSchedules.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.visitSchedules)
    .values({
      caregiverId,
      dependantId,
      scheduledStart: new Date('2026-10-01T09:00:00Z'),
      scheduledEnd: new Date('2026-10-01T10:00:00Z'),
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

async function createTestBiometricEnrollment(
  caregiverId: string,
  s3Key: string,
  qualityScore: number,
): Promise<void> {
  const db = getDb();
  await db.insert(schema.biometricEnrollments).values({
    subjectType: 'caregiver',
    caregiverId,
    s3Key,
    imageOrder: 1,
    qualityScore,
    status: 'active',
    enrolledBy: caregiverId,
  });
}

async function createTestDependantBiometricEnrollment(
  dependantId: string,
  enrolledById: string,
  s3Key: string,
  qualityScore: number,
): Promise<void> {
  const db = getDb();
  await db.insert(schema.biometricEnrollments).values({
    subjectType: 'dependant',
    dependantId,
    s3Key,
    imageOrder: 1,
    qualityScore,
    status: 'active',
    enrolledBy: enrolledById,
  });
}

function checkinPhotoS3Key(
  visitScheduleId: string,
  subject: 'caregiver' | 'dependant' = 'caregiver',
): string {
  return `${visitScheduleId}/${subject}/photo.jpg`;
}

async function passCaregiverLiveness(
  app: Express,
  sub: string,
  visitScheduleId: string,
  sessionToken: string,
): Promise<void> {
  const response = await request(app)
    .post(`/visit-schedules/${visitScheduleId}/checkin/caregiver-liveness`)
    .set('x-test-auth', testAuthHeader(sub, 'caregiver'))
    .set('x-checkin-session-token', sessionToken)
    .send({ s3Key: checkinPhotoS3Key(visitScheduleId, 'caregiver') });
  if (response.status !== 200 || !(response.body as { passed?: boolean }).passed) {
    throw new Error(
      `Test setup failed to pass the caregiver step: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
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

describe.skipIf(!hasTestDb)('POST .../checkin/caregiver-liveness (real Postgres)', () => {
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

  describe('POST .../caregiver-liveness/upload-url', () => {
    it('presigns a photo upload once a session token is held', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      const sessionToken = await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/caregiver-liveness/upload-url`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', sessionToken)
        .send({ contentType: 'image/jpeg' });

      expect(response.status).toBe(201);
      const body = uploadUrlBody(response);
      expect(body.uploadUrl).toBeTruthy();
      expect(body.s3Key).toBeTruthy();
    });

    it('rejects a missing check-in session token with 401', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/caregiver-liveness/upload-url`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .send({ contentType: 'image/jpeg' });

      expect(response.status).toBe(401);
    });

    it('rejects a wrong check-in session token with 401', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/caregiver-liveness/upload-url`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', 'not-the-real-token')
        .send({ contentType: 'image/jpeg' });

      expect(response.status).toBe(401);
    });
  });

  describe('POST .../caregiver-liveness (submit)', () => {
    it('passes end to end: single-face photo + identity match, updates verification_events, cleans up the photo', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      await createTestBiometricEnrollment(caregiver.userId, 'enrolled/cg-1/1.jpg', 90);
      const frameStorage = fakeFrameStorage();
      app = buildTestApp(20, 600, { frameStorage });
      const sessionToken = await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/caregiver-liveness`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', sessionToken)
        .send({ s3Key: checkinPhotoS3Key(visit.id) });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        passed: true,
        matchConfidence: 95,
        failureReason: null,
      });
      expect(frameStorage.deleteObjects).toHaveBeenCalledWith([checkinPhotoS3Key(visit.id)]);

      const db = getDb();
      const [event] = await db
        .select()
        .from(schema.verificationEvents)
        .where(eq(schema.verificationEvents.visitScheduleId, visit.id));
      expect(event?.caregiverLivenessPassed).toBe(true);
      expect(Number(event?.caregiverMatchConfidence)).toBeCloseTo(95, 1);

      const attempts = await db
        .select()
        .from(schema.verificationAttempts)
        .where(
          and(
            eq(schema.verificationAttempts.visitScheduleId, visit.id),
            eq(schema.verificationAttempts.attemptType, 'caregiver_liveness'),
          ),
        );
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ passed: true });
    });

    it('reports a no-face-detected photo failure without touching verification_events pass state', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      const frameStorage = fakeFrameStorage();
      app = buildTestApp(20, 600, {
        photoValidator: {
          validatePhoto: vi.fn().mockResolvedValue({ ok: false, reason: 'no_face_detected' }),
        },
        frameStorage,
      });
      const sessionToken = await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/caregiver-liveness`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', sessionToken)
        .send({ s3Key: checkinPhotoS3Key(visit.id) });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        passed: false,
        matchConfidence: null,
        failureReason: 'no_face_detected',
      });
      expect(frameStorage.deleteObjects).toHaveBeenCalled();

      const db = getDb();
      const [event] = await db
        .select()
        .from(schema.verificationEvents)
        .where(eq(schema.verificationEvents.visitScheduleId, visit.id));
      expect(event?.caregiverLivenessPassed).toBeNull();
    });

    it('reports not_enrolled when the caregiver has no active biometric enrollment', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      const faceMatcher = fakeFaceMatcher();
      app = buildTestApp(20, 600, { faceMatcher });
      const sessionToken = await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/caregiver-liveness`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', sessionToken)
        .send({ s3Key: checkinPhotoS3Key(visit.id) });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ passed: false, failureReason: 'not_enrolled' });
      expect(faceMatcher.compareAgainstCandidates).not.toHaveBeenCalled();
    });

    it('reports identity_mismatch when CompareFaces does not clear the threshold', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      await createTestBiometricEnrollment(caregiver.userId, 'enrolled/cg-1/1.jpg', 90);
      app = buildTestApp(20, 600, {
        faceMatcher: {
          compareAgainstCandidates: vi
            .fn()
            .mockResolvedValue({ matched: false, bestSimilarity: 62 }),
        },
      });
      const sessionToken = await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/caregiver-liveness`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', sessionToken)
        .send({ s3Key: checkinPhotoS3Key(visit.id) });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        passed: false,
        matchConfidence: 62,
        failureReason: 'identity_mismatch',
      });
    });

    it('rejects a missing check-in session token with 401', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/caregiver-liveness`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .send({ s3Key: checkinPhotoS3Key(visit.id) });

      expect(response.status).toBe(401);
    });

    it('rejects a photo s3Key that does not belong to this visit/caregiver with 400', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      const sessionToken = await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/caregiver-liveness`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', sessionToken)
        .send({ s3Key: 'someone-else/caregiver/photo.jpg' });

      expect(response.status).toBe(400);
    });

    it('rejects a photo that was never actually uploaded with 400', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      app = buildTestApp(20, 600, {
        frameStorage: {
          ...fakeFrameStorage(),
          objectExists: vi.fn().mockResolvedValue(false),
        },
      });
      const sessionToken = await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/caregiver-liveness`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', sessionToken)
        .send({ s3Key: checkinPhotoS3Key(visit.id) });

      expect(response.status).toBe(400);
    });
  });
});

describe.skipIf(!hasTestDb)('POST .../checkin/dependant-liveness (real Postgres)', () => {
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

  describe('POST .../dependant-liveness/upload-url', () => {
    it('presigns a photo upload once a session token is held', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      const sessionToken = await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/dependant-liveness/upload-url`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', sessionToken)
        .send({ contentType: 'image/jpeg' });

      expect(response.status).toBe(201);
      expect(uploadUrlBody(response).uploadUrl).toBeTruthy();
    });
  });

  describe('POST .../dependant-liveness (submit)', () => {
    it('rejects the dependant step with 409 before the caregiver step has passed', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      const sessionToken = await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/dependant-liveness`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', sessionToken)
        .send({ s3Key: checkinPhotoS3Key(visit.id, 'dependant') });

      expect(response.status).toBe(409);
      expect(problemBody(response).detail).toMatch(/caregiver check-in step must pass/);
    });

    it('rejects the dependant step with 409 once the co-presence window has expired', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      await createTestBiometricEnrollment(caregiver.userId, 'enrolled/cg-1/1.jpg', 90);
      // A window so short it has already elapsed by the time the dependant step is submitted.
      app = buildTestApp(20, 600, {}, 0);
      const sessionToken = await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);
      await passCaregiverLiveness(app, 'cg-1', visit.id, sessionToken);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/dependant-liveness`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', sessionToken)
        .send({ s3Key: checkinPhotoS3Key(visit.id, 'dependant') });

      expect(response.status).toBe(409);
      expect(problemBody(response).detail).toMatch(/co-presence|dependant step must be submitted/);
    });

    it('passes end to end: writes verification_events, flips visit_schedules to in_progress, cleans up the photo', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      await createTestBiometricEnrollment(caregiver.userId, 'enrolled/cg-1/1.jpg', 90);
      await createTestDependantBiometricEnrollment(
        dependant.id,
        supervisor.id,
        'enrolled/dep-1/1.jpg',
        90,
      );
      const frameStorage = fakeFrameStorage();
      app = buildTestApp(20, 600, { frameStorage });
      const sessionToken = await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);
      await passCaregiverLiveness(app, 'cg-1', visit.id, sessionToken);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/dependant-liveness`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', sessionToken)
        .send({ s3Key: checkinPhotoS3Key(visit.id, 'dependant') });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ passed: true, matchConfidence: 95 });
      expect(frameStorage.deleteObjects).toHaveBeenCalledWith([
        checkinPhotoS3Key(visit.id, 'dependant'),
      ]);

      const db = getDb();
      const [event] = await db
        .select()
        .from(schema.verificationEvents)
        .where(eq(schema.verificationEvents.visitScheduleId, visit.id));
      expect(event?.dependantLivenessPassed).toBe(true);
      expect(Number(event?.dependantMatchConfidence)).toBeCloseTo(95, 1);
      expect(event?.checkinAt).not.toBeNull();

      const [updatedVisit] = await db
        .select()
        .from(schema.visitSchedules)
        .where(eq(schema.visitSchedules.id, visit.id));
      expect(updatedVisit?.status).toBe('in_progress');

      const attempts = await db
        .select()
        .from(schema.verificationAttempts)
        .where(
          and(
            eq(schema.verificationAttempts.visitScheduleId, visit.id),
            eq(schema.verificationAttempts.attemptType, 'dependant_liveness'),
          ),
        );
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ passed: true });
    });

    it('reports not_enrolled for the dependant without touching visit_schedules.status', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      await createTestBiometricEnrollment(caregiver.userId, 'enrolled/cg-1/1.jpg', 90);
      const faceMatcher = fakeFaceMatcher();
      app = buildTestApp(20, 600, { faceMatcher });
      const sessionToken = await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);
      await passCaregiverLiveness(app, 'cg-1', visit.id, sessionToken);
      // The caregiver step above already called compareAgainstCandidates once (the caregiver does
      // have an active enrollment) - the dependant step must add no further calls, since it should
      // short-circuit on not_enrolled before ever reaching CompareFaces.
      const callsBeforeDependantStep = vi.mocked(faceMatcher.compareAgainstCandidates).mock.calls
        .length;

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/dependant-liveness`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', sessionToken)
        .send({ s3Key: checkinPhotoS3Key(visit.id, 'dependant') });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ passed: false, failureReason: 'not_enrolled' });
      expect(faceMatcher.compareAgainstCandidates).toHaveBeenCalledTimes(callsBeforeDependantStep);

      const db = getDb();
      const [updatedVisit] = await db
        .select()
        .from(schema.visitSchedules)
        .where(eq(schema.visitSchedules.id, visit.id));
      expect(updatedVisit?.status).toBe('scheduled');
    });

    it('rejects a dependant photo s3Key that does not belong to this visit/subject with 400', async () => {
      const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
      const caregiver = await createTestCaregiver('cg-1', '+254700000002');
      const dependant = await createTestDependant(supervisor.id);
      const visit = await createTestVisit(caregiver.userId, dependant.id, supervisor.id);
      await createTestBiometricEnrollment(caregiver.userId, 'enrolled/cg-1/1.jpg', 90);
      const sessionToken = await passGeofenceAndGetSessionToken(app, 'cg-1', visit.id);
      await passCaregiverLiveness(app, 'cg-1', visit.id, sessionToken);

      const response = await request(app)
        .post(`/visit-schedules/${visit.id}/checkin/dependant-liveness`)
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .set('x-checkin-session-token', sessionToken)
        .send({ s3Key: checkinPhotoS3Key(visit.id, 'caregiver') });

      expect(response.status).toBe(400);
    });
  });
});

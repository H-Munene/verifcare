// Integration tests for POST /biometric-enrollments/upload-url, POST/GET /biometric-enrollments
// (HEZ-31) against a real local Postgres - see users.integration.test.ts's header comment for why
// (real unique-constraint/transaction behavior, not a faked query builder) and for the
// test-auth-header pattern used here too.
//
// db/biometricStorage.ts's S3/Rekognition calls are faked (vi.fn()) rather than hitting real AWS -
// this file only needs to prove the router's own RBAC/ownership/supersede/error-mapping logic,
// which is independent of what Rekognition or S3 actually do.

import { eq } from 'drizzle-orm';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, UserRole } from '../auth/verifier.js';
import type { BiometricStorage } from '../db/biometricStorage.js';
import * as schema from '../db/schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../db/testSupport.js';
import { createBiometricEnrollmentsRouter } from './biometricEnrollments.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function testAuthHeader(user: AuthenticatedUser): string {
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

interface EnrollmentBody {
  id: string;
  subjectType: 'caregiver' | 'dependant';
  caregiverId: string | null;
  dependantId: string | null;
  imageOrder: number;
  qualityScore: number | null;
  status: 'active' | 'superseded' | 'deleted';
}
interface UploadUrlBody {
  uploadUrl: string;
  s3Key: string;
  expiresAt: string;
}
function enrollmentBody(response: request.Response): EnrollmentBody {
  return response.body as EnrollmentBody;
}
function uploadUrlBody(response: request.Response): UploadUrlBody {
  return response.body as UploadUrlBody;
}
function enrollmentListBody(response: request.Response): EnrollmentBody[] {
  return response.body as EnrollmentBody[];
}

function buildTestApp(storage: BiometricStorage): Express {
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

  app.use('/biometric-enrollments', createBiometricEnrollmentsRouter({ requireAuth, storage }));
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
  fullName = `User ${sub}`,
): Promise<typeof schema.users.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.users)
    .values({ cognitoSub: sub, fullName, phoneNumber, role })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test user.');
  }
  return row;
}

async function createTestCaregiver(sub: string): Promise<typeof schema.users.$inferSelect> {
  const db = getDb();
  const userRow = await createTestUser(sub, 'caregiver', '+254700000200');
  await db.insert(schema.caregivers).values({ userId: userRow.id });
  return userRow;
}

async function createTestDependant(
  registeredBy: string,
): Promise<typeof schema.dependants.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.dependants)
    .values({
      fullName: 'Grandma Wanjiru',
      dob: '1945-03-01',
      geofenceLat: -1.286389,
      geofenceLng: 36.817223,
      geofenceRadiusMeters: 100,
      registeredBy,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test dependant.');
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

function fakeStorage(overrides: Partial<BiometricStorage> = {}): BiometricStorage {
  return {
    createUploadUrl: vi.fn().mockResolvedValue({
      uploadUrl: 'https://example-bucket.s3.amazonaws.com/signed',
      s3Key: 'placeholder/key.jpg',
      expiresAt: new Date('2026-01-01T00:05:00.000Z'),
    }),
    objectExists: vi.fn().mockResolvedValue(true),
    assessFaceQuality: vi.fn().mockResolvedValue({ ok: true, qualityScore: 80 }),
    ...overrides,
  };
}

describe.skipIf(!hasTestDb)(
  'POST /biometric-enrollments/upload-url, POST/GET /biometric-enrollments (real Postgres)',
  () => {
    beforeAll(async () => {
      await setupTestDb();
    });

    beforeEach(async () => {
      await truncateAllTables();
    });

    afterAll(async () => {
      await teardownTestDb();
    });

    describe('POST /biometric-enrollments/upload-url', () => {
      it('lets a supervisor request an upload URL for a caregiver', async () => {
        const caregiver = await createTestCaregiver('caregiver-1-sub');
        const storage = fakeStorage();
        const app = buildTestApp(storage);
        const auth = testAuthHeader({
          sub: 'supervisor-sub',
          role: 'supervisor',
          email: undefined,
        });

        const res = await request(app)
          .post('/biometric-enrollments/upload-url')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'caregiver',
            subjectId: caregiver.id,
            imageOrder: 1,
            contentType: 'image/jpeg',
          });

        expect(res.status).toBe(201);
        expect(uploadUrlBody(res).s3Key).toBe('placeholder/key.jpg');
        expect(storage.createUploadUrl).toHaveBeenCalledWith({
          subjectType: 'caregiver',
          subjectId: caregiver.id,
          imageOrder: 1,
          contentType: 'image/jpeg',
        });
      });

      it('lets a family member request an upload URL for their linked dependant', async () => {
        const supervisor = await createTestUser('supervisor-sub', 'supervisor', '+254700000001');
        const dependant = await createTestDependant(supervisor.id);
        const familyMember = await createTestUser('fm-sub', 'family_member', '+254700000002');
        await linkFamilyMember(dependant.id, familyMember.id);
        const app = buildTestApp(fakeStorage());
        const auth = testAuthHeader({ sub: 'fm-sub', role: 'family_member', email: undefined });

        const res = await request(app)
          .post('/biometric-enrollments/upload-url')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'dependant',
            subjectId: dependant.id,
            imageOrder: 1,
            contentType: 'image/jpeg',
          });

        expect(res.status).toBe(201);
      });

      it('forbids a family member from acting on a caregiver', async () => {
        const caregiver = await createTestCaregiver('caregiver-1-sub');
        const app = buildTestApp(fakeStorage());
        const auth = testAuthHeader({ sub: 'fm-sub', role: 'family_member', email: undefined });

        const res = await request(app)
          .post('/biometric-enrollments/upload-url')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'caregiver',
            subjectId: caregiver.id,
            imageOrder: 1,
            contentType: 'image/jpeg',
          });

        expect(res.status).toBe(403);
      });

      it('forbids a family member from acting on a dependant they are not linked to', async () => {
        const supervisor = await createTestUser('supervisor-sub', 'supervisor', '+254700000001');
        const dependant = await createTestDependant(supervisor.id);
        const app = buildTestApp(fakeStorage());
        const auth = testAuthHeader({
          sub: 'unlinked-fm-sub',
          role: 'family_member',
          email: undefined,
        });

        const res = await request(app)
          .post('/biometric-enrollments/upload-url')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'dependant',
            subjectId: dependant.id,
            imageOrder: 1,
            contentType: 'image/jpeg',
          });

        expect(res.status).toBe(403);
      });

      it('forbids a caregiver from every route in this file', async () => {
        const caregiver = await createTestCaregiver('caregiver-1-sub');
        const app = buildTestApp(fakeStorage());
        const auth = testAuthHeader({
          sub: 'caregiver-1-sub',
          role: 'caregiver',
          email: undefined,
        });

        const res = await request(app)
          .post('/biometric-enrollments/upload-url')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'caregiver',
            subjectId: caregiver.id,
            imageOrder: 1,
            contentType: 'image/jpeg',
          });

        expect(res.status).toBe(403);
      });

      it('404s a supervisor request for a caregiver that does not exist', async () => {
        const app = buildTestApp(fakeStorage());
        const auth = testAuthHeader({
          sub: 'supervisor-sub',
          role: 'supervisor',
          email: undefined,
        });

        const res = await request(app)
          .post('/biometric-enrollments/upload-url')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'caregiver',
            subjectId: '00000000-0000-0000-0000-000000000000',
            imageOrder: 1,
            contentType: 'image/jpeg',
          });

        expect(res.status).toBe(404);
      });
    });

    describe('POST /biometric-enrollments', () => {
      async function setupCaregiverSubject(): Promise<{ subjectId: string; auth: string }> {
        const caregiver = await createTestCaregiver('caregiver-1-sub');
        // The confirm route resolves the caller's own users row for enrolledBy - unlike
        // routes/caregivers.ts, a supervisor caller here must actually have one.
        await createTestUser('supervisor-sub', 'supervisor', '+254700000001');
        const auth = testAuthHeader({
          sub: 'supervisor-sub',
          role: 'supervisor',
          email: undefined,
        });
        return { subjectId: caregiver.id, auth };
      }

      it('writes a row with the computed quality_score on the happy path', async () => {
        const { subjectId, auth } = await setupCaregiverSubject();
        const storage = fakeStorage({
          assessFaceQuality: vi.fn().mockResolvedValue({ ok: true, qualityScore: 72.5 }),
        });
        const app = buildTestApp(storage);

        const res = await request(app)
          .post('/biometric-enrollments')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'caregiver',
            subjectId,
            imageOrder: 1,
            s3Key: `caregiver/${subjectId}/1/photo-a.jpg`,
          });

        expect(res.status).toBe(201);
        const body = enrollmentBody(res);
        expect(body.qualityScore).toBe(72.5);
        expect(body.status).toBe('active');
        expect(body.caregiverId).toBe(subjectId);
      });

      it('rejects with 400 when s3Key does not match the subject/imageOrder prefix', async () => {
        const { subjectId, auth } = await setupCaregiverSubject();
        const app = buildTestApp(fakeStorage());

        const res = await request(app)
          .post('/biometric-enrollments')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'caregiver',
            subjectId,
            imageOrder: 1,
            s3Key: 'some/unrelated/key.jpg',
          });

        expect(res.status).toBe(400);
      });

      it('rejects with 400 when the object was never uploaded', async () => {
        const { subjectId, auth } = await setupCaregiverSubject();
        const storage = fakeStorage({ objectExists: vi.fn().mockResolvedValue(false) });
        const app = buildTestApp(storage);

        const res = await request(app)
          .post('/biometric-enrollments')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'caregiver',
            subjectId,
            imageOrder: 1,
            s3Key: `caregiver/${subjectId}/1/photo-a.jpg`,
          });

        expect(res.status).toBe(400);
      });

      it('rejects with 422 and writes no row when no face is detected', async () => {
        const { subjectId, auth } = await setupCaregiverSubject();
        const storage = fakeStorage({
          assessFaceQuality: vi.fn().mockResolvedValue({ ok: false, reason: 'no_face_detected' }),
        });
        const app = buildTestApp(storage);

        const res = await request(app)
          .post('/biometric-enrollments')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'caregiver',
            subjectId,
            imageOrder: 1,
            s3Key: `caregiver/${subjectId}/1/photo-a.jpg`,
          });

        expect(res.status).toBe(422);
        const rows = await getDb()
          .select()
          .from(schema.biometricEnrollments)
          .where(eq(schema.biometricEnrollments.caregiverId, subjectId));
        expect(rows).toHaveLength(0);
      });

      it('rejects with 422 when multiple faces are detected', async () => {
        const { subjectId, auth } = await setupCaregiverSubject();
        const storage = fakeStorage({
          assessFaceQuality: vi
            .fn()
            .mockResolvedValue({ ok: false, reason: 'multiple_faces_detected' }),
        });
        const app = buildTestApp(storage);

        const res = await request(app)
          .post('/biometric-enrollments')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'caregiver',
            subjectId,
            imageOrder: 1,
            s3Key: `caregiver/${subjectId}/1/photo-a.jpg`,
          });

        expect(res.status).toBe(422);
      });

      it('supersedes the previous active row for the same subject/imageOrder on re-enrollment', async () => {
        const { subjectId, auth } = await setupCaregiverSubject();
        const app = buildTestApp(fakeStorage());

        const first = await request(app)
          .post('/biometric-enrollments')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'caregiver',
            subjectId,
            imageOrder: 1,
            s3Key: `caregiver/${subjectId}/1/photo-a.jpg`,
          });
        expect(first.status).toBe(201);
        const firstId = enrollmentBody(first).id;

        const second = await request(app)
          .post('/biometric-enrollments')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'caregiver',
            subjectId,
            imageOrder: 1,
            s3Key: `caregiver/${subjectId}/1/photo-b.jpg`,
          });
        expect(second.status).toBe(201);

        const rows = await getDb()
          .select()
          .from(schema.biometricEnrollments)
          .where(eq(schema.biometricEnrollments.caregiverId, subjectId));
        const firstRow = rows.find((r) => r.id === firstId);
        const secondRow = rows.find((r) => r.id === enrollmentBody(second).id);
        expect(firstRow?.status).toBe('superseded');
        expect(secondRow?.status).toBe('active');
      });

      it('returns 409 when the same s3Key is confirmed twice', async () => {
        const { subjectId, auth } = await setupCaregiverSubject();
        const app = buildTestApp(fakeStorage());
        const s3Key = `caregiver/${subjectId}/1/photo-a.jpg`;

        const first = await request(app)
          .post('/biometric-enrollments')
          .set('x-test-auth', auth)
          .send({ subjectType: 'caregiver', subjectId, imageOrder: 1, s3Key });
        expect(first.status).toBe(201);

        const second = await request(app)
          .post('/biometric-enrollments')
          .set('x-test-auth', auth)
          .send({ subjectType: 'caregiver', subjectId, imageOrder: 1, s3Key });

        expect(second.status).toBe(409);
      });
    });

    describe('GET /biometric-enrollments', () => {
      it('lists active enrollments before superseded ones, highest quality_score first', async () => {
        const caregiver = await createTestCaregiver('caregiver-1-sub');
        await createTestUser('supervisor-sub', 'supervisor', '+254700000001');
        const auth = testAuthHeader({
          sub: 'supervisor-sub',
          role: 'supervisor',
          email: undefined,
        });
        const app = buildTestApp(
          fakeStorage({
            assessFaceQuality: vi.fn().mockResolvedValue({ ok: true, qualityScore: 50 }),
          }),
        );

        await request(app)
          .post('/biometric-enrollments')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'caregiver',
            subjectId: caregiver.id,
            imageOrder: 1,
            s3Key: `caregiver/${caregiver.id}/1/low-quality.jpg`,
          });

        const highQualityApp = buildTestApp(
          fakeStorage({
            assessFaceQuality: vi.fn().mockResolvedValue({ ok: true, qualityScore: 90 }),
          }),
        );
        await request(highQualityApp)
          .post('/biometric-enrollments')
          .set('x-test-auth', auth)
          .send({
            subjectType: 'caregiver',
            subjectId: caregiver.id,
            imageOrder: 2,
            s3Key: `caregiver/${caregiver.id}/2/high-quality.jpg`,
          });

        const res = await request(app)
          .get('/biometric-enrollments')
          .query({ subjectType: 'caregiver', subjectId: caregiver.id })
          .set('x-test-auth', auth);

        expect(res.status).toBe(200);
        const rows = enrollmentListBody(res);
        expect(rows.every((r) => r.status === 'active')).toBe(true);
        expect(rows[0]?.qualityScore).toBe(90);
        expect(rows[1]?.qualityScore).toBe(50);
      });

      it('forbids a family member from listing a dependant they are not linked to', async () => {
        const supervisor = await createTestUser('supervisor-sub', 'supervisor', '+254700000001');
        const dependant = await createTestDependant(supervisor.id);
        const app = buildTestApp(fakeStorage());
        const auth = testAuthHeader({
          sub: 'unlinked-fm-sub',
          role: 'family_member',
          email: undefined,
        });

        const res = await request(app)
          .get('/biometric-enrollments')
          .query({ subjectType: 'dependant', subjectId: dependant.id })
          .set('x-test-auth', auth);

        expect(res.status).toBe(403);
      });
    });
  },
);

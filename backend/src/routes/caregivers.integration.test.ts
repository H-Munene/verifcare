// Integration tests for POST/GET /caregivers, GET/PATCH /caregivers/{caregiverId} (HEZ-29) against
// a real local Postgres - see users.integration.test.ts's header comment for why (real
// unique-constraint/transaction behavior, not a faked query builder) and for the test-auth-header
// pattern used here too.

import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CognitoAdmin } from '../auth/cognitoAdmin.js';
import type { AuthenticatedUser } from '../auth/verifier.js';
import type { BiometricFaceCollection } from '../db/biometricFaceCollection.js';
import * as schema from '../db/schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../db/testSupport.js';
import { createCaregiversRouter } from './caregivers.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function testAuthHeader(user: AuthenticatedUser): string {
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

interface CaregiverBody {
  userId: string;
  fullName: string;
  email: string | null;
  phoneNumber: string | null;
  idType: string | null;
  idNumber: string | null;
  dob: string | null;
  gender: string | null;
  occupation: string | null;
  employeeNumber: string | null;
  hireDate: string | null;
  active: boolean;
}
interface CaregiverPageBody {
  items: CaregiverBody[];
  nextCursor: string | null;
}

// Every field createCaregiverRequestSchema now requires (2026-09-22, HEZ-54) - a shared base so
// each test only has to spell out what it's actually varying, not all eight required fields every
// time. cognitoSub/email/phoneNumber default to obviously-overridable placeholders since most
// tests need unique values per call (cognitoSub/email/phoneNumber are all unique-constrained).
function validCaregiverBody(overrides: Record<string, unknown> = {}) {
  return {
    cognitoSub: 'caregiver-sub',
    fullName: 'Grace Hopper',
    email: 'grace@example.com',
    phoneNumber: '+254700000000',
    idType: 'national_id',
    idNumber: 'ID-0001',
    dob: '1990-01-01',
    gender: 'female',
    occupation: 'nurse',
    ...overrides,
  };
}
// supertest types response.body as `any` (it's just parsed JSON) - a single cast point per
// response, rather than scattering `as` assertions across every property access below.
function caregiverBody(response: request.Response): CaregiverBody {
  return response.body as CaregiverBody;
}
function caregiverPageBody(response: request.Response): CaregiverPageBody {
  return response.body as CaregiverPageBody;
}

function buildTestApp(
  cognitoAdmin: CognitoAdmin,
  faceCollection?: BiometricFaceCollection,
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

  app.use('/caregivers', createCaregiversRouter({ cognitoAdmin, requireAuth, faceCollection }));
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ title: 'Internal Server Error', message: String(err) });
    },
  );
  return app;
}

const supervisorAuth = testAuthHeader({
  sub: 'supervisor-sub',
  role: 'supervisor',
  email: undefined,
});
const caregiverAuth = testAuthHeader({
  sub: 'some-caregiver-sub',
  role: 'caregiver',
  email: undefined,
});

describe.skipIf(!hasTestDb)(
  'POST/GET /caregivers, GET/PATCH /caregivers/{caregiverId} (real Postgres)',
  () => {
    let app: Express;
    let cognitoAdmin: CognitoAdmin;

    beforeAll(async () => {
      await setupTestDb();
    });

    beforeEach(async () => {
      await truncateAllTables();
      cognitoAdmin = {
        assignRole: vi.fn().mockResolvedValue(undefined),
        createUser: vi.fn().mockResolvedValue('unused-sub'),
        lookupUserByEmail: vi.fn().mockResolvedValue(null),
      };
      app = buildTestApp(cognitoAdmin);
    });

    afterAll(async () => {
      await teardownTestDb();
    });

    describe('POST /caregivers', () => {
      it('creates both the users and caregivers rows atomically, assigns the Cognito role, and auto-generates employeeNumber/hireDate', async () => {
        const response = await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send(
            validCaregiverBody({
              cognitoSub: 'new-caregiver-sub',
              email: 'grace.new@example.com',
              phoneNumber: '+254700000030',
              fullName: 'Grace Hopper',
            }),
          );

        expect(response.status).toBe(201);
        expect(response.body).toMatchObject({
          fullName: 'Grace Hopper',
          email: 'grace.new@example.com',
          phoneNumber: '+254700000030',
          idType: 'national_id',
          idNumber: 'ID-0001',
          dob: '1990-01-01',
          gender: 'female',
          occupation: 'nurse',
          active: true,
        });
        // Neither is ever sent by the client (createCaregiverRequestSchema has no such fields) -
        // this confirms the DB defaults actually fired, not just that the fields are absent.
        expect(caregiverBody(response).employeeNumber).toMatch(/^CG-\d{4}$/);
        expect(caregiverBody(response).hireDate).not.toBeNull();
        expect(cognitoAdmin.assignRole).toHaveBeenCalledWith('new-caregiver-sub', 'caregiver');
      });

      it('returns 403 for a non-supervisor caller', async () => {
        const response = await request(app)
          .post('/caregivers')
          .set('x-test-auth', caregiverAuth)
          .send(validCaregiverBody({ cognitoSub: 'x', email: 'x@example.com' }));

        expect(response.status).toBe(403);
        expect(cognitoAdmin.assignRole).not.toHaveBeenCalled();
      });

      it('returns 409 for a duplicate cognitoSub', async () => {
        await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send(
            validCaregiverBody({
              cognitoSub: 'dup-caregiver-sub',
              email: 'dup-first@example.com',
              phoneNumber: '+254700000032',
              fullName: 'First',
            }),
          );

        const response = await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send(
            validCaregiverBody({
              cognitoSub: 'dup-caregiver-sub',
              email: 'dup-second@example.com',
              phoneNumber: '+254700000033',
              fullName: 'Second',
            }),
          );

        expect(response.status).toBe(409);
      });

      it('returns 400 for an invalid dob format', async () => {
        const response = await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send(
            validCaregiverBody({
              cognitoSub: 'y',
              email: 'y@example.com',
              phoneNumber: '+254700000034',
              fullName: 'Y',
              dob: '13-09-2026',
            }),
          );

        expect(response.status).toBe(400);
      });

      it('returns 400 when a required field (occupation) is missing', async () => {
        const body = validCaregiverBody({ cognitoSub: 'z', email: 'z@example.com' }) as Record<
          string,
          unknown
        >;
        delete body.occupation;

        const response = await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send(body);

        expect(response.status).toBe(400);
      });
    });

    describe('GET /caregivers/cognito-lookup', () => {
      it('returns the resolved Cognito identity for a found email', async () => {
        cognitoAdmin.lookupUserByEmail = vi.fn().mockResolvedValue({
          cognitoSub: 'looked-up-sub',
          email: 'amina@example.com',
          phoneNumber: '+254700000099',
          fullName: 'Amina Wanjiru',
        });

        const response = await request(app)
          .get('/caregivers/cognito-lookup')
          .query({ email: 'amina@example.com' })
          .set('x-test-auth', supervisorAuth);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          cognitoSub: 'looked-up-sub',
          email: 'amina@example.com',
          phoneNumber: '+254700000099',
          fullName: 'Amina Wanjiru',
        });
        expect(cognitoAdmin.lookupUserByEmail).toHaveBeenCalledWith('amina@example.com');
      });

      it('returns 404 when no Cognito user has that email', async () => {
        cognitoAdmin.lookupUserByEmail = vi.fn().mockResolvedValue(null);

        const response = await request(app)
          .get('/caregivers/cognito-lookup')
          .query({ email: 'nobody@example.com' })
          .set('x-test-auth', supervisorAuth);

        expect(response.status).toBe(404);
      });

      it('returns 400 for a malformed email', async () => {
        const response = await request(app)
          .get('/caregivers/cognito-lookup')
          .query({ email: 'not-an-email' })
          .set('x-test-auth', supervisorAuth);

        expect(response.status).toBe(400);
      });

      it('returns 403 for a non-supervisor caller', async () => {
        const response = await request(app)
          .get('/caregivers/cognito-lookup')
          .query({ email: 'amina@example.com' })
          .set('x-test-auth', caregiverAuth);

        expect(response.status).toBe(403);
        expect(cognitoAdmin.lookupUserByEmail).not.toHaveBeenCalled();
      });
    });

    describe('GET /caregivers', () => {
      beforeEach(async () => {
        for (let i = 0; i < 3; i += 1) {
          await request(app)
            .post('/caregivers')
            .set('x-test-auth', supervisorAuth)
            .send(
              validCaregiverBody({
                cognitoSub: `list-caregiver-${i}`,
                email: `list-${i}@example.com`,
                phoneNumber: `+25470000004${i}`,
                fullName: `Caregiver ${i}`,
              }),
            );
        }
        // Deactivate one so the `active` filter has something real to filter on.
        const list = caregiverPageBody(
          await request(app).get('/caregivers').set('x-test-auth', supervisorAuth),
        );
        const firstItem = list.items[0];
        if (!firstItem) {
          throw new Error('Expected at least one caregiver in the list.');
        }
        await request(app)
          .patch(`/caregivers/${firstItem.userId}`)
          .set('x-test-auth', supervisorAuth)
          .send({ active: false });
      });

      it('returns 403 for a non-supervisor', async () => {
        const response = await request(app).get('/caregivers').set('x-test-auth', caregiverAuth);
        expect(response.status).toBe(403);
      });

      it('filters by active status', async () => {
        const activeResponse = await request(app)
          .get('/caregivers?active=true')
          .set('x-test-auth', supervisorAuth);
        expect(activeResponse.status).toBe(200);
        const active = caregiverPageBody(activeResponse);
        expect(active.items).toHaveLength(2);
        expect(active.items.every((c) => c.active)).toBe(true);

        const inactiveResponse = await request(app)
          .get('/caregivers?active=false')
          .set('x-test-auth', supervisorAuth);
        expect(inactiveResponse.status).toBe(200);
        expect(caregiverPageBody(inactiveResponse).items).toHaveLength(1);
      });

      it('paginates correctly with a small limit', async () => {
        const page1 = caregiverPageBody(
          await request(app).get('/caregivers?limit=2').set('x-test-auth', supervisorAuth),
        );
        expect(page1.items).toHaveLength(2);
        expect(page1.nextCursor).not.toBeNull();

        const page2 = caregiverPageBody(
          await request(app)
            .get(`/caregivers?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`)
            .set('x-test-auth', supervisorAuth),
        );
        expect(page2.items).toHaveLength(1);
        expect(page2.nextCursor).toBeNull();
      });
    });

    describe('GET /caregivers/:caregiverId', () => {
      it('returns the caregiver for a supervisor, and 404s for a nonexistent id', async () => {
        const created = await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send(
            validCaregiverBody({
              cognitoSub: 'target-caregiver',
              email: 'target@example.com',
              phoneNumber: '+254700000050',
              fullName: 'Target',
            }),
          );

        const found = await request(app)
          .get(`/caregivers/${caregiverBody(created).userId}`)
          .set('x-test-auth', supervisorAuth);
        expect(found.status).toBe(200);
        expect(caregiverBody(found).fullName).toBe('Target');

        const notFound = await request(app)
          .get('/caregivers/00000000-0000-7000-8000-000000000000')
          .set('x-test-auth', supervisorAuth);
        expect(notFound.status).toBe(404);
      });

      it('returns 403 for a non-supervisor even viewing their own record', async () => {
        const created = await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send(
            validCaregiverBody({
              cognitoSub: 'self-caregiver',
              email: 'self@example.com',
              phoneNumber: '+254700000051',
              fullName: 'Self',
            }),
          );

        const response = await request(app)
          .get(`/caregivers/${caregiverBody(created).userId}`)
          .set('x-test-auth', caregiverAuth);
        expect(response.status).toBe(403);
      });
    });

    describe('PATCH /caregivers/:caregiverId', () => {
      it('updates fields on both the users and caregivers rows', async () => {
        const created = await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send(
            validCaregiverBody({
              cognitoSub: 'patch-target',
              email: 'patch-target@example.com',
              phoneNumber: '+254700000060',
              fullName: 'Before',
            }),
          );

        const response = await request(app)
          .patch(`/caregivers/${caregiverBody(created).userId}`)
          .set('x-test-auth', supervisorAuth)
          .send({ fullName: 'After', active: false, employeeNumber: 'EMP-999' });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          fullName: 'After',
          active: false,
          employeeNumber: 'EMP-999',
        });
      });

      it('returns 409 on a duplicate employeeNumber', async () => {
        // employeeNumber is never client-supplied at create time anymore (auto-generated) - this
        // now exercises the PATCH-time uniqueness check by colliding with an auto-generated value.
        const first = await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send(
            validCaregiverBody({
              cognitoSub: 'emp-a',
              email: 'emp-a@example.com',
              phoneNumber: '+254700000061',
              fullName: 'A',
            }),
          );
        const second = await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send(
            validCaregiverBody({
              cognitoSub: 'emp-b',
              email: 'emp-b@example.com',
              phoneNumber: '+254700000062',
              fullName: 'B',
            }),
          );

        const response = await request(app)
          .patch(`/caregivers/${caregiverBody(second).userId}`)
          .set('x-test-auth', supervisorAuth)
          .send({ employeeNumber: caregiverBody(first).employeeNumber });

        expect(response.status).toBe(409);
      });

      it('returns 404 for a nonexistent caregiver', async () => {
        const response = await request(app)
          .patch('/caregivers/00000000-0000-7000-8000-000000000000')
          .set('x-test-auth', supervisorAuth)
          .send({ active: false });

        expect(response.status).toBe(404);
      });

      it('cleans up indexed biometric enrollments when deactivated (HEZ-85)', async () => {
        const faceCollection: BiometricFaceCollection = {
          checkDuplicate: vi.fn(),
          indexFace: vi.fn(),
          deleteFaces: vi.fn().mockResolvedValue(undefined),
        };
        const localApp = buildTestApp(cognitoAdmin, faceCollection);
        const created = await request(localApp)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send(
            validCaregiverBody({
              cognitoSub: 'offboard-target',
              email: 'offboard@example.com',
              phoneNumber: '+254700000070',
              fullName: 'Offboard',
            }),
          );
        const caregiverId = caregiverBody(created).userId;

        const db = getDb();
        await db.insert(schema.biometricEnrollments).values({
          subjectType: 'caregiver',
          caregiverId,
          s3Key: `caregiver/${caregiverId}/1/photo.jpg`,
          imageOrder: 1,
          status: 'active',
          rekognitionFaceId: 'face-id-1',
          enrolledBy: caregiverId,
        });

        const response = await request(localApp)
          .patch(`/caregivers/${caregiverId}`)
          .set('x-test-auth', supervisorAuth)
          .send({ active: false });

        expect(response.status).toBe(200);
        expect(faceCollection.deleteFaces).toHaveBeenCalledWith(['face-id-1']);
        const [row] = await db
          .select()
          .from(schema.biometricEnrollments)
          .where(eq(schema.biometricEnrollments.caregiverId, caregiverId));
        expect(row?.status).toBe('deleted');
      });
    });
  },
);

// Integration tests for POST/GET /caregivers, GET/PATCH /caregivers/{caregiverId} (HEZ-29) against
// a real local Postgres - see users.integration.test.ts's header comment for why (real
// unique-constraint/transaction behavior, not a faked query builder) and for the test-auth-header
// pattern used here too.

import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CognitoAdmin } from '../auth/cognitoAdmin.js';
import type { AuthenticatedUser } from '../auth/verifier.js';
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
  phoneNumber: string | null;
  employeeNumber: string | null;
  active: boolean;
}
interface CaregiverPageBody {
  items: CaregiverBody[];
  nextCursor: string | null;
}
// supertest types response.body as `any` (it's just parsed JSON) - a single cast point per
// response, rather than scattering `as` assertions across every property access below.
function caregiverBody(response: request.Response): CaregiverBody {
  return response.body as CaregiverBody;
}
function caregiverPageBody(response: request.Response): CaregiverPageBody {
  return response.body as CaregiverPageBody;
}

function buildTestApp(cognitoAdmin: CognitoAdmin): Express {
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

  app.use('/caregivers', createCaregiversRouter({ cognitoAdmin, requireAuth }));
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
      };
      app = buildTestApp(cognitoAdmin);
    });

    afterAll(async () => {
      await teardownTestDb();
    });

    describe('POST /caregivers', () => {
      it('creates both the users and caregivers rows atomically, and assigns the Cognito role', async () => {
        const response = await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send({
            cognitoSub: 'new-caregiver-sub',
            phoneNumber: '+254700000030',
            fullName: 'Grace Hopper',
            employeeNumber: 'EMP-001',
          });

        expect(response.status).toBe(201);
        expect(response.body).toMatchObject({
          fullName: 'Grace Hopper',
          phoneNumber: '+254700000030',
          employeeNumber: 'EMP-001',
          active: true,
        });
        expect(cognitoAdmin.assignRole).toHaveBeenCalledWith('new-caregiver-sub', 'caregiver');
      });

      it('returns 403 for a non-supervisor caller', async () => {
        const response = await request(app)
          .post('/caregivers')
          .set('x-test-auth', caregiverAuth)
          .send({ cognitoSub: 'x', phoneNumber: '+254700000031', fullName: 'X' });

        expect(response.status).toBe(403);
        expect(cognitoAdmin.assignRole).not.toHaveBeenCalled();
      });

      it('returns 409 for a duplicate cognitoSub', async () => {
        await request(app).post('/caregivers').set('x-test-auth', supervisorAuth).send({
          cognitoSub: 'dup-caregiver-sub',
          phoneNumber: '+254700000032',
          fullName: 'First',
        });

        const response = await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send({
            cognitoSub: 'dup-caregiver-sub',
            phoneNumber: '+254700000033',
            fullName: 'Second',
          });

        expect(response.status).toBe(409);
      });

      it('returns 400 for an invalid hireDate format', async () => {
        const response = await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send({
            cognitoSub: 'y',
            phoneNumber: '+254700000034',
            fullName: 'Y',
            hireDate: '13-09-2026',
          });

        expect(response.status).toBe(400);
      });
    });

    describe('GET /caregivers', () => {
      beforeEach(async () => {
        for (let i = 0; i < 3; i += 1) {
          await request(app)
            .post('/caregivers')
            .set('x-test-auth', supervisorAuth)
            .send({
              cognitoSub: `list-caregiver-${i}`,
              phoneNumber: `+25470000004${i}`,
              fullName: `Caregiver ${i}`,
              ...(i === 0 ? { hireDate: undefined } : {}),
            });
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
          .send({
            cognitoSub: 'target-caregiver',
            phoneNumber: '+254700000050',
            fullName: 'Target',
          });

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
          .send({ cognitoSub: 'self-caregiver', phoneNumber: '+254700000051', fullName: 'Self' });

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
          .send({ cognitoSub: 'patch-target', phoneNumber: '+254700000060', fullName: 'Before' });

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
        await request(app).post('/caregivers').set('x-test-auth', supervisorAuth).send({
          cognitoSub: 'emp-a',
          phoneNumber: '+254700000061',
          fullName: 'A',
          employeeNumber: 'EMP-DUP',
        });
        const second = await request(app)
          .post('/caregivers')
          .set('x-test-auth', supervisorAuth)
          .send({ cognitoSub: 'emp-b', phoneNumber: '+254700000062', fullName: 'B' });

        const response = await request(app)
          .patch(`/caregivers/${caregiverBody(second).userId}`)
          .set('x-test-auth', supervisorAuth)
          .send({ employeeNumber: 'EMP-DUP' });

        expect(response.status).toBe(409);
      });

      it('returns 404 for a nonexistent caregiver', async () => {
        const response = await request(app)
          .patch('/caregivers/00000000-0000-7000-8000-000000000000')
          .set('x-test-auth', supervisorAuth)
          .send({ active: false });

        expect(response.status).toBe(404);
      });
    });
  },
);

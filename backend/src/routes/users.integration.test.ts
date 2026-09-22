// Integration tests for POST/GET /users, GET/PATCH /users/{userId} (HEZ-29) against a real local
// Postgres, matching db/enforcement.integration.test.ts's established pattern (TEST_DATABASE_URL,
// describe.skipIf(!hasTestDb)) - RBAC/ownership logic and real unique-constraint 409 handling are
// exactly the kind of thing worth proving against a real database, not a faked query builder.
//
// requireAuth/requireVerifiedIdentity are replaced here with a small test-only middleware that
// reads req.auth/req.identity from a header the test sets directly - real JWT verification is
// already covered by auth/middleware.test.ts; these tests are about the route handlers' own
// business logic (ownership, role rules, pagination, conflict handling), not token verification.

import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CognitoAdmin } from '../auth/cognitoAdmin.js';
import type { AuthenticatedUser, VerifiedIdentity } from '../auth/verifier.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../db/testSupport.js';
import { createUsersRouter } from './users.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function testAuthHeader(user: AuthenticatedUser | VerifiedIdentity): string {
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

interface UserBody {
  id: string;
  fullName: string;
  role: string;
  status: string;
}
interface UserPageBody {
  items: UserBody[];
  nextCursor: string | null;
}
// supertest types response.body as `any` (it's just parsed JSON) - a single cast point per
// response, rather than scattering `as` assertions across every property access below.
function userBody(response: request.Response): UserBody {
  return response.body as UserBody;
}
function userPageBody(response: request.Response): UserPageBody {
  return response.body as UserPageBody;
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
  const requireVerifiedIdentity: express.RequestHandler = (req, res, next) => {
    const header = req.headers['x-test-auth'];
    if (typeof header !== 'string') {
      res.status(401).json({ title: 'Unauthorized' });
      return;
    }
    req.identity = JSON.parse(
      Buffer.from(header, 'base64url').toString('utf8'),
    ) as VerifiedIdentity;
    next();
  };

  app.use('/users', createUsersRouter({ cognitoAdmin, requireAuth, requireVerifiedIdentity }));
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ title: 'Internal Server Error', message: String(err) });
    },
  );
  return app;
}

describe.skipIf(!hasTestDb)('POST/GET /users, GET/PATCH /users/{userId} (real Postgres)', () => {
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

  describe('POST /users', () => {
    it('lets a brand-new self-signup (no role yet) register themselves as family_member', async () => {
      const response = await request(app)
        .post('/users')
        .set('x-test-auth', testAuthHeader({ sub: 'new-sub-1', role: undefined, email: undefined }))
        .send({
          cognitoSub: 'new-sub-1',
          fullName: 'Ada Lovelace',
          phoneNumber: '+254700000001',
          role: 'family_member',
        });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ fullName: 'Ada Lovelace', role: 'family_member' });
      expect(cognitoAdmin.assignRole).toHaveBeenCalledWith('new-sub-1', 'family_member');
    });

    it('rejects a brand-new self-signup trying to self-assign role: supervisor', async () => {
      const response = await request(app)
        .post('/users')
        .set('x-test-auth', testAuthHeader({ sub: 'new-sub-2', role: undefined, email: undefined }))
        .send({ cognitoSub: 'new-sub-2', fullName: 'Eve', role: 'supervisor' });

      expect(response.status).toBe(403);
      expect(cognitoAdmin.assignRole).not.toHaveBeenCalled();
    });

    it('rejects a self-registration attempt for a different cognitoSub', async () => {
      const response = await request(app)
        .post('/users')
        .set(
          'x-test-auth',
          testAuthHeader({ sub: 'caller-sub', role: undefined, email: undefined }),
        )
        .send({
          cognitoSub: 'someone-else-sub',
          fullName: 'Eve',
          phoneNumber: '+254700000010',
          role: 'family_member',
        });

      expect(response.status).toBe(403);
    });

    it('lets a supervisor create a user for anyone, with either allowed role', async () => {
      const response = await request(app)
        .post('/users')
        .set(
          'x-test-auth',
          testAuthHeader({ sub: 'supervisor-sub', role: 'supervisor', email: undefined }),
        )
        .send({ cognitoSub: 'invited-sub', fullName: 'New Supervisor', role: 'supervisor' });

      expect(response.status).toBe(201);
      expect(cognitoAdmin.assignRole).toHaveBeenCalledWith('invited-sub', 'supervisor');
    });

    it('rejects an existing non-supervisor trying to create a row for someone else', async () => {
      const response = await request(app)
        .post('/users')
        .set(
          'x-test-auth',
          testAuthHeader({ sub: 'fm-sub', role: 'family_member', email: undefined }),
        )
        .send({
          cognitoSub: 'someone-else',
          fullName: 'X',
          phoneNumber: '+254700000011',
          role: 'family_member',
        });

      expect(response.status).toBe(403);
    });

    it('returns 409 for a duplicate cognitoSub', async () => {
      const auth = testAuthHeader({ sub: 'dup-sub', role: undefined, email: undefined });
      await request(app).post('/users').set('x-test-auth', auth).send({
        cognitoSub: 'dup-sub',
        fullName: 'First',
        phoneNumber: '+254700000002',
        role: 'family_member',
      });

      const response = await request(app)
        .post('/users')
        .set(
          'x-test-auth',
          testAuthHeader({ sub: 'dup-sub', role: 'family_member', email: undefined }),
        )
        .send({
          cognitoSub: 'dup-sub',
          fullName: 'Second',
          phoneNumber: '+254700000003',
          role: 'family_member',
        });

      expect(response.status).toBe(409);
    });

    it('returns 400 for an invalid body (missing fullName)', async () => {
      const response = await request(app)
        .post('/users')
        .set('x-test-auth', testAuthHeader({ sub: 'new-sub-3', role: undefined, email: undefined }))
        .send({ cognitoSub: 'new-sub-3', role: 'family_member' });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /users', () => {
    beforeEach(async () => {
      for (let i = 0; i < 3; i += 1) {
        await request(app)
          .post('/users')
          .set(
            'x-test-auth',
            testAuthHeader({ sub: `list-sub-${i}`, role: undefined, email: undefined }),
          )
          .send({
            cognitoSub: `list-sub-${i}`,
            fullName: `User ${i}`,
            phoneNumber: `+25470000010${i}`,
            role: 'family_member',
          });
      }
    });

    it('returns 403 for a non-supervisor', async () => {
      const response = await request(app)
        .get('/users')
        .set(
          'x-test-auth',
          testAuthHeader({ sub: 'list-sub-0', role: 'family_member', email: undefined }),
        );

      expect(response.status).toBe(403);
    });

    it('lists users for a supervisor, paginating with a small limit', async () => {
      const auth = testAuthHeader({ sub: 'supervisor-sub', role: 'supervisor', email: undefined });

      const page1 = userPageBody(await request(app).get('/users?limit=2').set('x-test-auth', auth));
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = userPageBody(
        await request(app)
          .get(`/users?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`)
          .set('x-test-auth', auth),
      );
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();

      const allIds = [...page1.items, ...page2.items].map((u) => u.id);
      expect(new Set(allIds).size).toBe(3);
    });

    it('filters by an exact phoneNumber match', async () => {
      const auth = testAuthHeader({ sub: 'supervisor-sub', role: 'supervisor', email: undefined });

      const response = userPageBody(
        await request(app).get('/users?phoneNumber=%2B254700000101').set('x-test-auth', auth),
      );

      expect(response.items).toHaveLength(1);
      expect(response.items[0]).toMatchObject({ fullName: 'User 1' });
    });

    it('filters by an exact email match, added 2026-09-14 for the supervisor-search-by-email/phone flow', async () => {
      await request(app)
        .post('/users')
        .set('x-test-auth', testAuthHeader({ sub: 'email-sub', role: undefined, email: undefined }))
        .send({
          cognitoSub: 'email-sub',
          fullName: 'Has Email',
          phoneNumber: '+254700000199',
          email: 'searchable@example.com',
          role: 'family_member',
        });
      const auth = testAuthHeader({ sub: 'supervisor-sub', role: 'supervisor', email: undefined });

      const response = userPageBody(
        await request(app).get('/users?email=searchable%40example.com').set('x-test-auth', auth),
      );

      expect(response.items).toHaveLength(1);
      expect(response.items[0]).toMatchObject({ fullName: 'Has Email' });

      const noMatch = userPageBody(
        await request(app).get('/users?email=nobody%40example.com').set('x-test-auth', auth),
      );
      expect(noMatch.items).toHaveLength(0);
    });
  });

  describe('GET /users/:userId', () => {
    it('lets a supervisor view any user, and 404s for a nonexistent id', async () => {
      const created = await request(app)
        .post('/users')
        .set(
          'x-test-auth',
          testAuthHeader({ sub: 'target-sub', role: undefined, email: undefined }),
        )
        .send({
          cognitoSub: 'target-sub',
          fullName: 'Target',
          phoneNumber: '+254700000020',
          role: 'family_member',
        });

      const auth = testAuthHeader({ sub: 'supervisor-sub', role: 'supervisor', email: undefined });
      const found = await request(app)
        .get(`/users/${userBody(created).id}`)
        .set('x-test-auth', auth);
      expect(found.status).toBe(200);

      const notFound = await request(app)
        .get('/users/00000000-0000-7000-8000-000000000000')
        .set('x-test-auth', auth);
      expect(notFound.status).toBe(404);
    });

    it('lets a non-supervisor view their own row but not someone else’s', async () => {
      const created = await request(app)
        .post('/users')
        .set('x-test-auth', testAuthHeader({ sub: 'owner-sub', role: undefined, email: undefined }))
        .send({
          cognitoSub: 'owner-sub',
          fullName: 'Owner',
          phoneNumber: '+254700000021',
          role: 'family_member',
        });

      const targetId = userBody(created).id;
      const ownAuth = testAuthHeader({ sub: 'owner-sub', role: 'family_member', email: undefined });
      const own = await request(app).get(`/users/${targetId}`).set('x-test-auth', ownAuth);
      expect(own.status).toBe(200);

      const otherAuth = testAuthHeader({
        sub: 'someone-else-sub',
        role: 'family_member',
        email: undefined,
      });
      const other = await request(app).get(`/users/${targetId}`).set('x-test-auth', otherAuth);
      expect(other.status).toBe(403);
    });

    it('returns 400 for a malformed (non-UUID) userId', async () => {
      const auth = testAuthHeader({ sub: 'supervisor-sub', role: 'supervisor', email: undefined });
      const response = await request(app).get('/users/not-a-uuid').set('x-test-auth', auth);
      expect(response.status).toBe(400);
    });
  });

  describe('PATCH /users/:userId', () => {
    it('lets a user update their own fullName but not their own status', async () => {
      const created = await request(app)
        .post('/users')
        .set('x-test-auth', testAuthHeader({ sub: 'self-sub', role: undefined, email: undefined }))
        .send({
          cognitoSub: 'self-sub',
          fullName: 'Before',
          phoneNumber: '+254700000022',
          role: 'family_member',
        });
      const auth = testAuthHeader({ sub: 'self-sub', role: 'family_member', email: undefined });
      const targetId = userBody(created).id;

      const nameUpdate = await request(app)
        .patch(`/users/${targetId}`)
        .set('x-test-auth', auth)
        .send({ fullName: 'After' });
      expect(nameUpdate.status).toBe(200);
      expect(userBody(nameUpdate).fullName).toBe('After');

      const statusUpdate = await request(app)
        .patch(`/users/${targetId}`)
        .set('x-test-auth', auth)
        .send({ status: 'suspended' });
      expect(statusUpdate.status).toBe(403);
    });

    it('lets a supervisor change any user’s status', async () => {
      const created = await request(app)
        .post('/users')
        .set(
          'x-test-auth',
          testAuthHeader({ sub: 'target-sub-2', role: undefined, email: undefined }),
        )
        .send({
          cognitoSub: 'target-sub-2',
          fullName: 'Target',
          phoneNumber: '+254700000023',
          role: 'family_member',
        });
      const supervisorAuth = testAuthHeader({
        sub: 'supervisor-sub',
        role: 'supervisor',
        email: undefined,
      });

      const response = await request(app)
        .patch(`/users/${userBody(created).id}`)
        .set('x-test-auth', supervisorAuth)
        .send({ status: 'suspended' });

      expect(response.status).toBe(200);
      expect(userBody(response).status).toBe('suspended');
    });

    it('returns 404 for a nonexistent user', async () => {
      const auth = testAuthHeader({ sub: 'supervisor-sub', role: 'supervisor', email: undefined });
      const response = await request(app)
        .patch('/users/00000000-0000-7000-8000-000000000000')
        .set('x-test-auth', auth)
        .send({ fullName: 'Ghost' });
      expect(response.status).toBe(404);
    });
  });
});

// Integration tests for POST/GET /dependants, GET/PATCH /dependants/{dependantId},
// POST/GET /dependants/{dependantId}/family-members, and
// PATCH /dependants/{dependantId}/family-members/{userId} (HEZ-30) against a real local Postgres -
// see users.integration.test.ts's header comment for why (real unique-constraint/transaction
// behavior, not a faked query builder) and for the test-auth-header pattern used here too.
//
// Unlike routes/caregivers.ts, every handler here resolves the caller's own internal `users` row
// (getUserByCognitoSub), including for a supervisor caller - so every test that acts as a given
// sub must first insert a matching `users` row directly (createTestUser below), not just set an
// auth header the way caregivers.integration.test.ts's supervisorAuth constant could get away with.

import { and, eq } from 'drizzle-orm';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CognitoAdmin } from '../auth/cognitoAdmin.js';
import type { AuthenticatedUser, UserRole } from '../auth/verifier.js';
import type { BiometricFaceCollection } from '../db/biometricFaceCollection.js';
import * as schema from '../db/schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../db/testSupport.js';
import { createDependantsRouter } from './dependants.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function testAuthHeader(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

interface DependantBody {
  id: string;
  fullName: string;
  geofenceLat: number;
  status: string;
  registeredBy: string;
}
interface DependantPageBody {
  items: DependantBody[];
  nextCursor: string | null;
}
interface FamilyMemberBody {
  dependantId: string;
  familyMemberUserId: string;
  isPrimaryContact: boolean;
  relationship: string | null;
}
// supertest types response.body as `any` (it's just parsed JSON) - a single cast point per
// response, rather than scattering `as` assertions across every property access below.
function dependantBody(response: request.Response): DependantBody {
  return response.body as DependantBody;
}
function dependantPageBody(response: request.Response): DependantPageBody {
  return response.body as DependantPageBody;
}
function familyMemberBody(response: request.Response): FamilyMemberBody {
  return response.body as FamilyMemberBody;
}
function familyMemberListBody(response: request.Response): FamilyMemberBody[] {
  return response.body as FamilyMemberBody[];
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

  app.use('/dependants', createDependantsRouter({ cognitoAdmin, requireAuth, faceCollection }));
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
  email?: string,
): Promise<typeof schema.users.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .insert(schema.users)
    .values({ cognitoSub: sub, fullName, phoneNumber, role, email })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test user.');
  }
  return row;
}

function createDependantPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fullName: 'Grandma Wanjiru',
    dob: '1945-03-01',
    geofenceLat: -1.286389,
    geofenceLng: 36.817223,
    geofenceRadiusMeters: 100,
    primaryFamilyMember: {
      cognitoSub: 'fm-sub',
      phoneNumber: '+254700000100',
      fullName: 'Primary Contact',
    },
    ...overrides,
  };
}

describe.skipIf(!hasTestDb)(
  'POST/GET /dependants, GET/PATCH /dependants/{dependantId}, family-members (real Postgres)',
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
        createUser: vi
          .fn()
          .mockImplementation(({ email }: { email: string }) =>
            Promise.resolve(`created-sub-${email}`),
          ),
      };
      app = buildTestApp(cognitoAdmin);
    });

    afterAll(async () => {
      await teardownTestDb();
    });

    describe('POST /dependants', () => {
      it('lets a supervisor register a dependant naming an existing family_member as primary contact', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const fm = await createTestUser('fm-1', 'family_member', '+254700000002', 'Real Name');

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                cognitoSub: 'fm-1',
                // Deliberately different from the stored row - must be ignored (see the
                // "ignores submitted..." test below for the DB-level assertion).
                phoneNumber: '+254799999999',
                fullName: 'Someone Else Entirely',
              },
            }),
          );

        expect(response.status).toBe(201);
        expect(dependantBody(response)).toMatchObject({
          fullName: 'Grandma Wanjiru',
          status: 'active',
          registeredBy: supervisor.id,
        });
        expect(cognitoAdmin.assignRole).not.toHaveBeenCalled();

        const db = getDb();
        const [link] = await db
          .select()
          .from(schema.dependantFamilyMembers)
          .where(eq(schema.dependantFamilyMembers.dependantId, dependantBody(response).id));
        expect(link).toMatchObject({
          familyMemberUserId: fm.id,
          isPrimaryContact: true,
          addedBy: supervisor.id,
        });
      });

      it('ignores a mismatched phoneNumber/fullName for an existing family member rather than overwriting their profile', async () => {
        await createTestUser('sup-2', 'supervisor', '+254700000003');
        const fm = await createTestUser('fm-2', 'family_member', '+254700000004', 'Original Name');

        await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-2', 'supervisor'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                cognitoSub: 'fm-2',
                phoneNumber: '+254799999998',
                fullName: 'Overwritten Name',
              },
            }),
          );

        const db = getDb();
        const [reloaded] = await db.select().from(schema.users).where(eq(schema.users.id, fm.id));
        expect(reloaded).toMatchObject({ fullName: 'Original Name', phoneNumber: '+254700000004' });
      });

      it('lets a family_member register a dependant naming themselves as the primary contact', async () => {
        await createTestUser('fm-self', 'family_member', '+254700000005');

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('fm-self', 'family_member'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                cognitoSub: 'fm-self',
                phoneNumber: '+254700000005',
                fullName: 'User fm-self',
              },
            }),
          );

        expect(response.status).toBe(201);
      });

      it('rejects a family_member trying to name someone else as the primary contact', async () => {
        await createTestUser('fm-caller', 'family_member', '+254700000006');
        await createTestUser('fm-other', 'family_member', '+254700000007');

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('fm-caller', 'family_member'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                cognitoSub: 'fm-other',
                phoneNumber: '+254700000007',
                fullName: 'User fm-other',
              },
            }),
          );

        expect(response.status).toBe(403);
      });

      it('rejects a caregiver caller entirely', async () => {
        await createTestUser('cg-1', 'caregiver', '+254700000008');

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
          .send(createDependantPayload());

        expect(response.status).toBe(403);
      });

      it('creates a brand-new family-member user and assigns the Cognito role, for a cognitoSub with no existing row', async () => {
        await createTestUser('sup-3', 'supervisor', '+254700000009');

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-3', 'supervisor'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                cognitoSub: 'brand-new-fm',
                phoneNumber: '+254700000010',
                fullName: 'Brand New',
              },
            }),
          );

        expect(response.status).toBe(201);
        expect(cognitoAdmin.assignRole).toHaveBeenCalledWith('brand-new-fm', 'family_member');

        const db = getDb();
        const [created] = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.cognitoSub, 'brand-new-fm'));
        expect(created).toMatchObject({ role: 'family_member', fullName: 'Brand New' });
      });

      it('returns 409 when the primaryFamilyMember cognitoSub belongs to an existing non-family_member user', async () => {
        await createTestUser('sup-4', 'supervisor', '+254700000011');
        await createTestUser('cg-as-fm', 'caregiver', '+254700000012');

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-4', 'supervisor'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                cognitoSub: 'cg-as-fm',
                phoneNumber: '+254700000012',
                fullName: 'User cg-as-fm',
              },
            }),
          );

        expect(response.status).toBe(409);
        expect(cognitoAdmin.assignRole).not.toHaveBeenCalled();
      });

      it('returns 400 when the cognitoSub does not correspond to a real Cognito user', async () => {
        await createTestUser('sup-5', 'supervisor', '+254700000013');
        cognitoAdmin.assignRole = vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('User does not exist.'), { name: 'UserNotFoundException' }),
          );

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-5', 'supervisor'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                cognitoSub: 'nonexistent-cognito-user',
                phoneNumber: '+254700000014',
                fullName: 'Ghost',
              },
            }),
          );

        expect(response.status).toBe(400);
      });

      it('creates a brand-new Cognito identity via email when no cognitoSub is given', async () => {
        await createTestUser('sup-email-1', 'supervisor', '+254700000016');

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-email-1', 'supervisor'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                email: 'brand-new@example.com',
                phoneNumber: '+254700000017',
                fullName: 'Brand New By Email',
              },
            }),
          );

        expect(response.status).toBe(201);
        expect(cognitoAdmin.createUser).toHaveBeenCalledWith({
          email: 'brand-new@example.com',
          phoneNumber: '+254700000017',
          fullName: 'Brand New By Email',
          role: 'family_member',
        });
        expect(cognitoAdmin.assignRole).not.toHaveBeenCalled();

        const db = getDb();
        const [created] = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.email, 'brand-new@example.com'));
        expect(created).toMatchObject({
          role: 'family_member',
          fullName: 'Brand New By Email',
          cognitoSub: 'created-sub-brand-new@example.com',
        });
      });

      it('returns 409 when the primaryFamilyMember email belongs to an existing non-family_member user', async () => {
        await createTestUser('sup-email-2', 'supervisor', '+254700000018');
        await createTestUser(
          'cg-email',
          'caregiver',
          '+254700000019',
          'User cg-email',
          'cg-taken@example.com',
        );

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-email-2', 'supervisor'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                email: 'cg-taken@example.com',
                phoneNumber: '+254700000020',
                fullName: 'Irrelevant',
              },
            }),
          );

        expect(response.status).toBe(409);
        expect(cognitoAdmin.createUser).not.toHaveBeenCalled();
      });

      it('reuses an existing family_member found by email instead of creating a new Cognito identity', async () => {
        await createTestUser('sup-email-3', 'supervisor', '+254700000021');
        const fm = await createTestUser(
          'fm-email-existing',
          'family_member',
          '+254700000022',
          'User fm-email-existing',
          'existing-fm@example.com',
        );
        const db = getDb();

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-email-3', 'supervisor'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                email: 'existing-fm@example.com',
                phoneNumber: '+254799999997',
                fullName: 'Ignored',
              },
            }),
          );

        expect(response.status).toBe(201);
        expect(cognitoAdmin.createUser).not.toHaveBeenCalled();
        const [link] = await db
          .select()
          .from(schema.dependantFamilyMembers)
          .where(eq(schema.dependantFamilyMembers.dependantId, dependantBody(response).id));
        expect(link?.familyMemberUserId).toBe(fm.id);
      });

      it('returns 409 when the email already has a Cognito identity that cannot be found by searching', async () => {
        await createTestUser('sup-email-4', 'supervisor', '+254700000023');
        cognitoAdmin.createUser = vi.fn().mockRejectedValue(
          Object.assign(new Error('An account with the email already exists.'), {
            name: 'UsernameExistsException',
          }),
        );

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-email-4', 'supervisor'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                email: 'orphaned-cognito-user@example.com',
                phoneNumber: '+254700000024',
                fullName: 'Ghost',
              },
            }),
          );

        expect(response.status).toBe(409);
      });

      it('returns 400 when both cognitoSub and email are provided', async () => {
        await createTestUser('sup-email-5', 'supervisor', '+254700000025');

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-email-5', 'supervisor'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                cognitoSub: 'some-sub',
                email: 'both@example.com',
                phoneNumber: '+254700000026',
                fullName: 'Both Given',
              },
            }),
          );

        expect(response.status).toBe(400);
      });

      it('returns 400 when neither cognitoSub nor email is provided', async () => {
        await createTestUser('sup-email-6', 'supervisor', '+254700000027');

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-email-6', 'supervisor'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                phoneNumber: '+254700000028',
                fullName: 'Neither Given',
              },
            }),
          );

        expect(response.status).toBe(400);
      });

      it('returns 400 for an invalid body (missing fullName)', async () => {
        await createTestUser('sup-6', 'supervisor', '+254700000015');
        const invalidPayload = createDependantPayload();
        delete invalidPayload.fullName;

        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-6', 'supervisor'))
          .send(invalidPayload);

        expect(response.status).toBe(400);
      });
    });

    describe('GET /dependants', () => {
      it('lets a supervisor list every dependant, paginated', async () => {
        const supervisor = await createTestUser('sup-list', 'supervisor', '+254700000020');
        for (let i = 0; i < 3; i += 1) {
          await createTestUser(`fm-list-${i}`, 'family_member', `+25470000002${i + 1}`);
          await request(app)
            .post('/dependants')
            .set('x-test-auth', testAuthHeader('sup-list', 'supervisor'))
            .send(
              createDependantPayload({
                fullName: `Dependant ${i}`,
                primaryFamilyMember: {
                  cognitoSub: `fm-list-${i}`,
                  phoneNumber: `+25470000002${i + 1}`,
                  fullName: `User fm-list-${i}`,
                },
              }),
            );
        }
        void supervisor;

        const page1 = dependantPageBody(
          await request(app)
            .get('/dependants?limit=2')
            .set('x-test-auth', testAuthHeader('sup-list', 'supervisor')),
        );
        expect(page1.items).toHaveLength(2);
        expect(page1.nextCursor).not.toBeNull();

        const page2 = dependantPageBody(
          await request(app)
            .get(`/dependants?limit=2&cursor=${page1.nextCursor}`)
            .set('x-test-auth', testAuthHeader('sup-list', 'supervisor')),
        );
        expect(page2.items).toHaveLength(1);
        expect(page2.nextCursor).toBeNull();
      });

      it('lets a family_member list only the dependants they are linked to', async () => {
        await createTestUser('sup-scope', 'supervisor', '+254700000030');
        await createTestUser('fm-scope-a', 'family_member', '+254700000031');
        await createTestUser('fm-scope-b', 'family_member', '+254700000032');

        await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-scope', 'supervisor'))
          .send(
            createDependantPayload({
              fullName: 'Linked To A',
              primaryFamilyMember: {
                cognitoSub: 'fm-scope-a',
                phoneNumber: '+254700000031',
                fullName: 'User fm-scope-a',
              },
            }),
          );
        await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-scope', 'supervisor'))
          .send(
            createDependantPayload({
              fullName: 'Linked To B',
              primaryFamilyMember: {
                cognitoSub: 'fm-scope-b',
                phoneNumber: '+254700000032',
                fullName: 'User fm-scope-b',
              },
            }),
          );

        const response = dependantPageBody(
          await request(app)
            .get('/dependants')
            .set('x-test-auth', testAuthHeader('fm-scope-a', 'family_member')),
        );
        expect(response.items).toHaveLength(1);
        expect(response.items[0]).toMatchObject({ fullName: 'Linked To A' });
      });

      it('rejects a caregiver caller entirely', async () => {
        await createTestUser('cg-list', 'caregiver', '+254700000033');
        const response = await request(app)
          .get('/dependants')
          .set('x-test-auth', testAuthHeader('cg-list', 'caregiver'));
        expect(response.status).toBe(403);
      });
    });

    describe('GET /dependants/{dependantId}', () => {
      it('returns 404 for a nonexistent dependant', async () => {
        await createTestUser('sup-get-404', 'supervisor', '+254700000040');
        const response = await request(app)
          .get('/dependants/00000000-0000-7000-8000-000000000000')
          .set('x-test-auth', testAuthHeader('sup-get-404', 'supervisor'));
        expect(response.status).toBe(404);
      });

      it('returns 403 for a family_member who is not linked to the dependant', async () => {
        await createTestUser('sup-get', 'supervisor', '+254700000041');
        await createTestUser('fm-linked', 'family_member', '+254700000042');
        await createTestUser('fm-unlinked', 'family_member', '+254700000043');

        const created = dependantBody(
          await request(app)
            .post('/dependants')
            .set('x-test-auth', testAuthHeader('sup-get', 'supervisor'))
            .send(
              createDependantPayload({
                primaryFamilyMember: {
                  cognitoSub: 'fm-linked',
                  phoneNumber: '+254700000042',
                  fullName: 'User fm-linked',
                },
              }),
            ),
        );

        const response = await request(app)
          .get(`/dependants/${created.id}`)
          .set('x-test-auth', testAuthHeader('fm-unlinked', 'family_member'));
        expect(response.status).toBe(403);
      });
    });

    describe('PATCH /dependants/{dependantId}', () => {
      async function registerDependant(): Promise<{
        dependant: DependantBody;
        supervisorSub: string;
        primarySub: string;
      }> {
        await createTestUser('sup-patch', 'supervisor', '+254700000050');
        await createTestUser('fm-primary', 'family_member', '+254700000051');
        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-patch', 'supervisor'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                cognitoSub: 'fm-primary',
                phoneNumber: '+254700000051',
                fullName: 'User fm-primary',
              },
            }),
          );
        return {
          dependant: dependantBody(response),
          supervisorSub: 'sup-patch',
          primarySub: 'fm-primary',
        };
      }

      it('lets a supervisor update any field, including status', async () => {
        const { dependant, supervisorSub } = await registerDependant();

        const response = await request(app)
          .patch(`/dependants/${dependant.id}`)
          .set('x-test-auth', testAuthHeader(supervisorSub, 'supervisor'))
          .send({ status: 'deactivated', geofenceRadiusMeters: 200 });

        expect(response.status).toBe(200);
        expect(dependantBody(response)).toMatchObject({ status: 'deactivated' });
      });

      it('cleans up indexed biometric enrollments when deactivated (HEZ-85)', async () => {
        const faceCollection: BiometricFaceCollection = {
          checkDuplicate: vi.fn(),
          indexFace: vi.fn(),
          deleteFaces: vi.fn().mockResolvedValue(undefined),
        };
        const localApp = buildTestApp(cognitoAdmin, faceCollection);
        await createTestUser('sup-offboard', 'supervisor', '+254700000059');
        const created = await request(localApp)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-offboard', 'supervisor'))
          .send(createDependantPayload());
        const dependantId = dependantBody(created).id;
        const registeredBy = dependantBody(created).registeredBy;

        const db = getDb();
        await db.insert(schema.biometricEnrollments).values({
          subjectType: 'dependant',
          dependantId,
          s3Key: `dependant/${dependantId}/1/photo.jpg`,
          imageOrder: 1,
          status: 'active',
          rekognitionFaceId: 'face-id-1',
          enrolledBy: registeredBy,
        });

        const response = await request(localApp)
          .patch(`/dependants/${dependantId}`)
          .set('x-test-auth', testAuthHeader('sup-offboard', 'supervisor'))
          .send({ status: 'deactivated' });

        expect(response.status).toBe(200);
        expect(faceCollection.deleteFaces).toHaveBeenCalledWith(['face-id-1']);
        const [row] = await db
          .select()
          .from(schema.biometricEnrollments)
          .where(eq(schema.biometricEnrollments.dependantId, dependantId));
        expect(row?.status).toBe('deleted');
      });

      it('lets the primary-contact family member update non-status fields', async () => {
        const { dependant, primarySub } = await registerDependant();

        const response = await request(app)
          .patch(`/dependants/${dependant.id}`)
          .set('x-test-auth', testAuthHeader(primarySub, 'family_member'))
          .send({ geofenceRadiusMeters: 250 });

        expect(response.status).toBe(200);
        expect(dependantBody(response)).toMatchObject({ geofenceRadiusMeters: 250 });
      });

      it('forbids the primary-contact family member from changing status', async () => {
        const { dependant, primarySub } = await registerDependant();

        const response = await request(app)
          .patch(`/dependants/${dependant.id}`)
          .set('x-test-auth', testAuthHeader(primarySub, 'family_member'))
          .send({ status: 'deactivated' });

        expect(response.status).toBe(403);
      });

      it('forbids a linked but non-primary family member from updating at all', async () => {
        const { dependant, supervisorSub } = await registerDependant();
        await createTestUser('fm-nonprimary', 'family_member', '+254700000052');
        await request(app)
          .post(`/dependants/${dependant.id}/family-members`)
          .set('x-test-auth', testAuthHeader(supervisorSub, 'supervisor'))
          .send({
            cognitoSub: 'fm-nonprimary',
            phoneNumber: '+254700000052',
            fullName: 'Non Primary',
          });

        const response = await request(app)
          .patch(`/dependants/${dependant.id}`)
          .set('x-test-auth', testAuthHeader('fm-nonprimary', 'family_member'))
          .send({ geofenceRadiusMeters: 300 });

        expect(response.status).toBe(403);
      });
    });

    describe('POST /dependants/{dependantId}/family-members', () => {
      async function registerDependant(): Promise<{
        dependant: DependantBody;
        supervisorSub: string;
      }> {
        await createTestUser('sup-add', 'supervisor', '+254700000060');
        await createTestUser('fm-add-primary', 'family_member', '+254700000061');
        const response = await request(app)
          .post('/dependants')
          .set('x-test-auth', testAuthHeader('sup-add', 'supervisor'))
          .send(
            createDependantPayload({
              primaryFamilyMember: {
                cognitoSub: 'fm-add-primary',
                phoneNumber: '+254700000061',
                fullName: 'User fm-add-primary',
              },
            }),
          );
        return { dependant: dependantBody(response), supervisorSub: 'sup-add' };
      }

      it('lets a linked (non-primary) family member add another family member', async () => {
        const { dependant, supervisorSub } = await registerDependant();
        await createTestUser('fm-add-second', 'family_member', '+254700000062');
        await request(app)
          .post(`/dependants/${dependant.id}/family-members`)
          .set('x-test-auth', testAuthHeader(supervisorSub, 'supervisor'))
          .send({ cognitoSub: 'fm-add-second', phoneNumber: '+254700000062', fullName: 'Second' });

        const response = await request(app)
          .post(`/dependants/${dependant.id}/family-members`)
          .set('x-test-auth', testAuthHeader('fm-add-second', 'family_member'))
          .send({ cognitoSub: 'new-third-sub', phoneNumber: '+254700000063', fullName: 'Third' });

        expect(response.status).toBe(201);
      });

      it('forbids an unlinked family member from adding a family member', async () => {
        const { dependant } = await registerDependant();
        await createTestUser('fm-unlinked-2', 'family_member', '+254700000064');

        const response = await request(app)
          .post(`/dependants/${dependant.id}/family-members`)
          .set('x-test-auth', testAuthHeader('fm-unlinked-2', 'family_member'))
          .send({ cognitoSub: 'new-fourth-sub', phoneNumber: '+254700000065', fullName: 'Fourth' });

        expect(response.status).toBe(403);
      });

      it('auto-demotes the previous primary contact when isPrimaryContact: true is set', async () => {
        const { dependant, supervisorSub } = await registerDependant();

        const response = await request(app)
          .post(`/dependants/${dependant.id}/family-members`)
          .set('x-test-auth', testAuthHeader(supervisorSub, 'supervisor'))
          .send({
            cognitoSub: 'fm-new-primary',
            phoneNumber: '+254700000066',
            fullName: 'New Primary',
            isPrimaryContact: true,
          });
        expect(response.status).toBe(201);
        expect(familyMemberBody(response).isPrimaryContact).toBe(true);

        const db = getDb();
        const links = await db
          .select()
          .from(schema.dependantFamilyMembers)
          .where(eq(schema.dependantFamilyMembers.dependantId, dependant.id));
        const primaryLinks = links.filter((l) => l.isPrimaryContact);
        expect(primaryLinks).toHaveLength(1);
        expect(primaryLinks[0]?.familyMemberUserId).toBe(
          familyMemberBody(response).familyMemberUserId,
        );
      });

      it('returns 409 for a duplicate (dependantId, familyMemberUserId) link', async () => {
        const { dependant, supervisorSub } = await registerDependant();

        const response = await request(app)
          .post(`/dependants/${dependant.id}/family-members`)
          .set('x-test-auth', testAuthHeader(supervisorSub, 'supervisor'))
          .send({
            cognitoSub: 'fm-add-primary',
            phoneNumber: '+254700000061',
            fullName: 'User fm-add-primary',
          });

        expect(response.status).toBe(409);
      });
    });

    describe('GET /dependants/{dependantId}/family-members', () => {
      it('lets a linked family member list the dependant’s family members', async () => {
        await createTestUser('sup-list-fm', 'supervisor', '+254700000070');
        await createTestUser('fm-list-fm', 'family_member', '+254700000071');
        const created = dependantBody(
          await request(app)
            .post('/dependants')
            .set('x-test-auth', testAuthHeader('sup-list-fm', 'supervisor'))
            .send(
              createDependantPayload({
                primaryFamilyMember: {
                  cognitoSub: 'fm-list-fm',
                  phoneNumber: '+254700000071',
                  fullName: 'User fm-list-fm',
                },
              }),
            ),
        );

        const response = await request(app)
          .get(`/dependants/${created.id}/family-members`)
          .set('x-test-auth', testAuthHeader('fm-list-fm', 'family_member'));

        expect(response.status).toBe(200);
        expect(familyMemberListBody(response)).toHaveLength(1);
      });

      it('forbids an unlinked family member', async () => {
        await createTestUser('sup-list-fm-2', 'supervisor', '+254700000072');
        await createTestUser('fm-list-fm-2', 'family_member', '+254700000073');
        await createTestUser('fm-unlinked-3', 'family_member', '+254700000074');
        const created = dependantBody(
          await request(app)
            .post('/dependants')
            .set('x-test-auth', testAuthHeader('sup-list-fm-2', 'supervisor'))
            .send(
              createDependantPayload({
                primaryFamilyMember: {
                  cognitoSub: 'fm-list-fm-2',
                  phoneNumber: '+254700000073',
                  fullName: 'User fm-list-fm-2',
                },
              }),
            ),
        );

        const response = await request(app)
          .get(`/dependants/${created.id}/family-members`)
          .set('x-test-auth', testAuthHeader('fm-unlinked-3', 'family_member'));

        expect(response.status).toBe(403);
      });
    });

    describe('PATCH /dependants/{dependantId}/family-members/{userId}', () => {
      it('lets a supervisor update relationship', async () => {
        await createTestUser('sup-edit', 'supervisor', '+254700000080');
        const fm = await createTestUser('fm-edit', 'family_member', '+254700000081');
        const created = dependantBody(
          await request(app)
            .post('/dependants')
            .set('x-test-auth', testAuthHeader('sup-edit', 'supervisor'))
            .send(
              createDependantPayload({
                primaryFamilyMember: {
                  cognitoSub: 'fm-edit',
                  phoneNumber: '+254700000081',
                  fullName: 'User fm-edit',
                },
              }),
            ),
        );

        const response = await request(app)
          .patch(`/dependants/${created.id}/family-members/${fm.id}`)
          .set('x-test-auth', testAuthHeader('sup-edit', 'supervisor'))
          .send({ relationship: 'Daughter' });

        expect(response.status).toBe(200);
        expect(familyMemberBody(response)).toMatchObject({ relationship: 'Daughter' });
      });

      it('forbids a family member, even the primary contact themselves, from editing a link', async () => {
        await createTestUser('sup-edit-2', 'supervisor', '+254700000082');
        const fm = await createTestUser('fm-edit-2', 'family_member', '+254700000083');
        const created = dependantBody(
          await request(app)
            .post('/dependants')
            .set('x-test-auth', testAuthHeader('sup-edit-2', 'supervisor'))
            .send(
              createDependantPayload({
                primaryFamilyMember: {
                  cognitoSub: 'fm-edit-2',
                  phoneNumber: '+254700000083',
                  fullName: 'User fm-edit-2',
                },
              }),
            ),
        );

        const response = await request(app)
          .patch(`/dependants/${created.id}/family-members/${fm.id}`)
          .set('x-test-auth', testAuthHeader('fm-edit-2', 'family_member'))
          .send({ relationship: 'Daughter' });

        expect(response.status).toBe(403);
      });

      it('auto-demotes the old primary contact when reassigning isPrimaryContact: true', async () => {
        await createTestUser('sup-edit-3', 'supervisor', '+254700000084');
        const oldPrimary = await createTestUser('fm-old-primary', 'family_member', '+254700000085');
        const created = dependantBody(
          await request(app)
            .post('/dependants')
            .set('x-test-auth', testAuthHeader('sup-edit-3', 'supervisor'))
            .send(
              createDependantPayload({
                primaryFamilyMember: {
                  cognitoSub: 'fm-old-primary',
                  phoneNumber: '+254700000085',
                  fullName: 'User fm-old-primary',
                },
              }),
            ),
        );
        const newPrimaryLink = familyMemberBody(
          await request(app)
            .post(`/dependants/${created.id}/family-members`)
            .set('x-test-auth', testAuthHeader('sup-edit-3', 'supervisor'))
            .send({
              cognitoSub: 'fm-new-primary-2',
              phoneNumber: '+254700000086',
              fullName: 'New',
            }),
        );

        const response = await request(app)
          .patch(`/dependants/${created.id}/family-members/${newPrimaryLink.familyMemberUserId}`)
          .set('x-test-auth', testAuthHeader('sup-edit-3', 'supervisor'))
          .send({ isPrimaryContact: true });

        expect(response.status).toBe(200);
        expect(familyMemberBody(response).isPrimaryContact).toBe(true);

        const db = getDb();
        const [oldLink] = await db
          .select()
          .from(schema.dependantFamilyMembers)
          .where(
            and(
              eq(schema.dependantFamilyMembers.dependantId, created.id),
              eq(schema.dependantFamilyMembers.familyMemberUserId, oldPrimary.id),
            ),
          );
        expect(oldLink?.isPrimaryContact).toBe(false);
      });

      it('returns 404 for a nonexistent link', async () => {
        await createTestUser('sup-edit-4', 'supervisor', '+254700000087');
        const created = dependantBody(
          await request(app)
            .post('/dependants')
            .set('x-test-auth', testAuthHeader('sup-edit-4', 'supervisor'))
            .send(
              createDependantPayload({
                primaryFamilyMember: {
                  cognitoSub: 'fm-edit-4',
                  phoneNumber: '+254700000088',
                  fullName: 'User fm-edit-4',
                },
              }),
            ),
        );

        const response = await request(app)
          .patch(`/dependants/${created.id}/family-members/00000000-0000-7000-8000-000000000000`)
          .set('x-test-auth', testAuthHeader('sup-edit-4', 'supervisor'))
          .send({ relationship: 'Nobody' });

        expect(response.status).toBe(404);
      });
    });
  },
);

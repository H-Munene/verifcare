// Integration tests for POST /consent-records, GET /consent-records,
// POST /consent-records/{id}/revoke (HEZ-40) against a real local Postgres - see
// users.integration.test.ts's header comment for why (real ownership/RBAC behavior, not a faked
// query builder) and for the test-auth-header pattern used here too.

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
import { createConsentRecordsRouter } from './consentRecords.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function testAuthHeader(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

interface ConsentRecordBody {
  id: string;
  subjectType: 'caregiver' | 'dependant';
  caregiverId: string | null;
  dependantId: string | null;
  consentType: 'biometric_verification' | 'audio_cognitive_monitoring';
  grantedBy: string;
  grantedAt: string;
  revokedAt: string | null;
}
function consentBody(response: request.Response): ConsentRecordBody {
  return response.body as ConsentRecordBody;
}
function consentListBody(response: request.Response): ConsentRecordBody[] {
  return response.body as ConsentRecordBody[];
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

  app.use('/consent-records', createConsentRecordsRouter({ requireAuth }));
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
      geofenceLat: -1.2921,
      geofenceLng: 36.8219,
      geofenceRadiusMeters: 100,
      registeredBy: registeredById,
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

describe.skipIf(!hasTestDb)(
  'POST/GET /consent-records, POST /consent-records/{id}/revoke (real Postgres)',
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

    describe('POST /consent-records', () => {
      it('lets a supervisor record consent for a caregiver', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');

        const response = await request(app)
          .post('/consent-records')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({
            subjectType: 'caregiver',
            subjectId: caregiver.userId,
            consentType: 'biometric_verification',
          });

        expect(response.status).toBe(201);
        expect(consentBody(response)).toMatchObject({
          subjectType: 'caregiver',
          caregiverId: caregiver.userId,
          dependantId: null,
          consentType: 'biometric_verification',
          grantedBy: supervisor.id,
          revokedAt: null,
        });
      });

      it('lets a supervisor record consent for a dependant', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const dependant = await createTestDependant(supervisor.id);

        const response = await request(app)
          .post('/consent-records')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({
            subjectType: 'dependant',
            subjectId: dependant.id,
            consentType: 'audio_cognitive_monitoring',
          });

        expect(response.status).toBe(201);
        expect(consentBody(response)).toMatchObject({
          subjectType: 'dependant',
          caregiverId: null,
          dependantId: dependant.id,
          consentType: 'audio_cognitive_monitoring',
          grantedBy: supervisor.id,
        });
      });

      it('lets a linked family member record consent for their own dependant', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const dependant = await createTestDependant(supervisor.id);
        const familyMember = await createTestUser('fam-1', 'family_member', '+254700000003');
        await linkFamilyMember(dependant.id, familyMember.id);

        const response = await request(app)
          .post('/consent-records')
          .set('x-test-auth', testAuthHeader('fam-1', 'family_member'))
          .send({
            subjectType: 'dependant',
            subjectId: dependant.id,
            consentType: 'biometric_verification',
          });

        expect(response.status).toBe(201);
        expect(consentBody(response).grantedBy).toBe(familyMember.id);
      });

      it('rejects a family member recording consent for a caregiver with 403', async () => {
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        await createTestUser('fam-1', 'family_member', '+254700000003');

        const response = await request(app)
          .post('/consent-records')
          .set('x-test-auth', testAuthHeader('fam-1', 'family_member'))
          .send({
            subjectType: 'caregiver',
            subjectId: caregiver.userId,
            consentType: 'biometric_verification',
          });

        expect(response.status).toBe(403);
      });

      it('rejects a family member recording consent for a dependant they are not linked to with 403', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const dependant = await createTestDependant(supervisor.id);
        await createTestUser('fam-1', 'family_member', '+254700000003');

        const response = await request(app)
          .post('/consent-records')
          .set('x-test-auth', testAuthHeader('fam-1', 'family_member'))
          .send({
            subjectType: 'dependant',
            subjectId: dependant.id,
            consentType: 'biometric_verification',
          });

        expect(response.status).toBe(403);
      });

      it('rejects a caregiver caller outright with 403', async () => {
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');

        const response = await request(app)
          .post('/consent-records')
          .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
          .send({
            subjectType: 'caregiver',
            subjectId: caregiver.userId,
            consentType: 'biometric_verification',
          });

        expect(response.status).toBe(403);
      });

      it('returns 404 for a nonexistent caregiver subject', async () => {
        const response = await request(app)
          .post('/consent-records')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({
            subjectType: 'caregiver',
            subjectId: '01a0bfb1-61b8-7260-b9e3-2d549e1bda49',
            consentType: 'biometric_verification',
          });

        expect(response.status).toBe(404);
      });
    });

    describe('GET /consent-records', () => {
      it("lets a supervisor list a caregiver's consent records", async () => {
        await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        await request(app)
          .post('/consent-records')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({
            subjectType: 'caregiver',
            subjectId: caregiver.userId,
            consentType: 'biometric_verification',
          });

        const response = await request(app)
          .get(`/consent-records?subjectType=caregiver&subjectId=${caregiver.userId}`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(200);
        expect(consentListBody(response)).toHaveLength(1);
      });

      it('rejects a family member listing a dependant they are not linked to with 403', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const dependant = await createTestDependant(supervisor.id);
        await createTestUser('fam-1', 'family_member', '+254700000003');

        const response = await request(app)
          .get(`/consent-records?subjectType=dependant&subjectId=${dependant.id}`)
          .set('x-test-auth', testAuthHeader('fam-1', 'family_member'));

        expect(response.status).toBe(403);
      });

      it('returns an empty array when no consent has been recorded', async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const dependant = await createTestDependant(supervisor.id);

        const response = await request(app)
          .get(`/consent-records?subjectType=dependant&subjectId=${dependant.id}`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(200);
        expect(consentListBody(response)).toEqual([]);
      });
    });

    describe('POST /consent-records/{id}/revoke', () => {
      it("lets a linked family member revoke their own dependant's consent", async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const dependant = await createTestDependant(supervisor.id);
        const familyMember = await createTestUser('fam-1', 'family_member', '+254700000003');
        await linkFamilyMember(dependant.id, familyMember.id);
        const created = await request(app)
          .post('/consent-records')
          .set('x-test-auth', testAuthHeader('fam-1', 'family_member'))
          .send({
            subjectType: 'dependant',
            subjectId: dependant.id,
            consentType: 'biometric_verification',
          });

        const response = await request(app)
          .post(`/consent-records/${consentBody(created).id}/revoke`)
          .set('x-test-auth', testAuthHeader('fam-1', 'family_member'));

        expect(response.status).toBe(200);
        expect(consentBody(response).revokedAt).not.toBeNull();
      });

      it("rejects a family member revoking another dependant's consent with 403", async () => {
        const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000001');
        const dependant = await createTestDependant(supervisor.id);
        const created = await request(app)
          .post('/consent-records')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({
            subjectType: 'dependant',
            subjectId: dependant.id,
            consentType: 'biometric_verification',
          });
        await createTestUser('fam-1', 'family_member', '+254700000003');

        const response = await request(app)
          .post(`/consent-records/${consentBody(created).id}/revoke`)
          .set('x-test-auth', testAuthHeader('fam-1', 'family_member'));

        expect(response.status).toBe(403);
      });

      it('is idempotent: revoking an already-revoked record leaves the original revokedAt untouched', async () => {
        await createTestUser('sup-1', 'supervisor', '+254700000001');
        const caregiver = await createTestCaregiver('cg-1', '+254700000002');
        const created = await request(app)
          .post('/consent-records')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'))
          .send({
            subjectType: 'caregiver',
            subjectId: caregiver.userId,
            consentType: 'biometric_verification',
          });
        const first = await request(app)
          .post(`/consent-records/${consentBody(created).id}/revoke`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));
        expect(first.status).toBe(200);

        const second = await request(app)
          .post(`/consent-records/${consentBody(created).id}/revoke`)
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(second.status).toBe(200);
        expect(consentBody(second).revokedAt).toBe(consentBody(first).revokedAt);
      });

      it('returns 404 for a nonexistent consent record', async () => {
        await createTestUser('sup-1', 'supervisor', '+254700000001');

        const response = await request(app)
          .post('/consent-records/01a0bfb1-61b8-7260-b9e3-2d549e1bda49/revoke')
          .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));

        expect(response.status).toBe(404);
      });
    });
  },
);

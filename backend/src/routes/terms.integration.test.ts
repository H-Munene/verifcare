// Integration tests for GET /terms/current and POST /terms/current/accept against a real local
// Postgres, using the same test-auth-header pattern as notifications.integration.test.ts. The
// point is the real per-version record, its append-only trigger, and the stale-version guard.

import { eq, sql } from 'drizzle-orm';
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
import { CURRENT_TERMS } from '../terms.js';
import { createTermsRouter } from './terms.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function testAuthHeader(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

interface TermsBody {
  document: string;
  version: string;
  title: string;
  sections: { heading: string; paragraphs: string[] }[];
  acceptedAt: string | null;
}
function termsBody(response: request.Response): TermsBody {
  return response.body as TermsBody;
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
  app.use('/terms', createTermsRouter({ requireAuth }));
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ title: 'Internal Server Error', message: String(err) });
    },
  );
  return app;
}

async function createTestUser(sub: string, role: UserRole, phoneNumber: string) {
  const [row] = await getDb()
    .insert(schema.users)
    .values({ cognitoSub: sub, fullName: `User ${sub}`, phoneNumber, role })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test user.');
  }
  return row;
}

describe.skipIf(!hasTestDb)('GET/POST /terms/current (real Postgres)', () => {
  let app: Express;

  beforeAll(async () => {
    await setupTestDb();
    app = buildTestApp();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("serves each app's own document, not accepted until the user accepts that version", async () => {
    await createTestUser('cg-1', 'caregiver', '+254700000001');
    await createTestUser('fm-1', 'family_member', '+254700000002');

    const caregiver = termsBody(
      await request(app)
        .get('/terms/current')
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver')),
    );
    expect(caregiver).toMatchObject({
      document: 'caregiver',
      version: CURRENT_TERMS.caregiver.version,
      acceptedAt: null,
    });
    expect(caregiver.sections.length).toBeGreaterThan(0);

    const family = termsBody(
      await request(app)
        .get('/terms/current')
        .set('x-test-auth', testAuthHeader('fm-1', 'family_member')),
    );
    expect(family.document).toBe('family_member');

    const accepted = await request(app)
      .post('/terms/current/accept')
      .set('x-test-auth', testAuthHeader('fm-1', 'family_member'))
      .send({ version: CURRENT_TERMS.family_member.version });
    expect(accepted.status).toBe(200);
    const firstAcceptedAt = termsBody(accepted).acceptedAt;
    expect(firstAcceptedAt).not.toBeNull();

    const after = termsBody(
      await request(app)
        .get('/terms/current')
        .set('x-test-auth', testAuthHeader('fm-1', 'family_member')),
    );
    expect(after.acceptedAt).toBe(firstAcceptedAt);

    // Accepting again keeps the original record and time.
    const again = await request(app)
      .post('/terms/current/accept')
      .set('x-test-auth', testAuthHeader('fm-1', 'family_member'))
      .send({ version: CURRENT_TERMS.family_member.version });
    expect(termsBody(again).acceptedAt).toBe(firstAcceptedAt);
    expect(await getDb().select().from(schema.termsAcceptances)).toHaveLength(1);

    // The caregiver's own status is unaffected.
    const caregiverAfter = termsBody(
      await request(app)
        .get('/terms/current')
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver')),
    );
    expect(caregiverAfter.acceptedAt).toBeNull();
  });

  it('refuses agreement to a version other than the current one (409)', async () => {
    await createTestUser('cg-1', 'caregiver', '+254700000001');
    const response = await request(app)
      .post('/terms/current/accept')
      .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
      .send({ version: 'an-old-version' });
    expect(response.status).toBe(409);
    expect(await getDb().select().from(schema.termsAcceptances)).toHaveLength(0);
  });

  it('has no terms for a supervisor, and needs a registered user', async () => {
    await createTestUser('sup-1', 'supervisor', '+254700000003');
    const supervisor = await request(app)
      .get('/terms/current')
      .set('x-test-auth', testAuthHeader('sup-1', 'supervisor'));
    expect(supervisor.status).toBe(404);

    const unregistered = await request(app)
      .get('/terms/current')
      .set('x-test-auth', testAuthHeader('fm-unregistered', 'family_member'));
    expect(unregistered.status).toBe(403);
  });

  it('keeps acceptances append-only', async () => {
    const user = await createTestUser('cg-1', 'caregiver', '+254700000001');
    await request(app)
      .post('/terms/current/accept')
      .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
      .send({ version: CURRENT_TERMS.caregiver.version });

    await expect(
      getDb()
        .update(schema.termsAcceptances)
        .set({ acceptedAt: sql`now() - interval '1 day'` })
        .where(eq(schema.termsAcceptances.userId, user.id)),
    ).rejects.toThrow();
    await expect(
      getDb().delete(schema.termsAcceptances).where(eq(schema.termsAcceptances.userId, user.id)),
    ).rejects.toThrow();
  });
});

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

// What the consent screen sends once both checkboxes are ticked.
function acceptBody(version: string, overrides: Record<string, unknown> = {}) {
  return { version, biometricConsent: true, audioConsent: true, ...overrides };
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

async function createTestCaregiver(sub: string, phoneNumber: string) {
  const user = await createTestUser(sub, 'caregiver', phoneNumber);
  await getDb().insert(schema.caregivers).values({ userId: user.id });
  return user;
}

async function createTestDependant(
  registeredBy: string,
  status: 'active' | 'deactivated' = 'active',
): Promise<string> {
  const [row] = await getDb()
    .insert(schema.dependants)
    .values({
      fullName: 'Test Dependant',
      dob: '1950-01-01',
      geofenceLat: -1.2921,
      geofenceLng: 36.8219,
      geofenceRadiusMeters: 100,
      registeredBy,
      status,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to insert test dependant.');
  }
  return row.id;
}

async function linkFamilyMember(dependantId: string, userId: string, isPrimaryContact: boolean) {
  await getDb().insert(schema.dependantFamilyMembers).values({
    dependantId,
    familyMemberUserId: userId,
    isPrimaryContact,
    addedBy: userId,
  });
}

async function consentRows() {
  return getDb()
    .select({
      caregiverId: schema.consentRecords.caregiverId,
      dependantId: schema.consentRecords.dependantId,
      consentType: schema.consentRecords.consentType,
      grantedBy: schema.consentRecords.grantedBy,
      revokedAt: schema.consentRecords.revokedAt,
    })
    .from(schema.consentRecords);
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
      .send(acceptBody(CURRENT_TERMS.family_member.version));
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
      .send(acceptBody(CURRENT_TERMS.family_member.version));
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
      .send(acceptBody('an-old-version'));
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
      .send(acceptBody(CURRENT_TERMS.caregiver.version));

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
  it('refuses an acceptance unless both consents are given (400)', async () => {
    await createTestCaregiver('cg-1', '+254700000001');
    for (const overrides of [
      { biometricConsent: false },
      { audioConsent: false },
      { biometricConsent: undefined },
      { audioConsent: 'yes' },
    ]) {
      const response = await request(app)
        .post('/terms/current/accept')
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .send(acceptBody(CURRENT_TERMS.caregiver.version, overrides));
      expect(response.status).toBe(400);
    }
    expect(await getDb().select().from(schema.termsAcceptances)).toHaveLength(0);
    expect(await consentRows()).toHaveLength(0);
  });

  it("records the caregiver's own photo and audio consent with the acceptance", async () => {
    const caregiver = await createTestCaregiver('cg-1', '+254700000001');
    const response = await request(app)
      .post('/terms/current/accept')
      .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
      .send(acceptBody(CURRENT_TERMS.caregiver.version));
    expect(response.status).toBe(200);

    const [acceptance] = await getDb().select().from(schema.termsAcceptances);
    expect(acceptance).toMatchObject({ biometricConsent: true, audioConsent: true });
    const rows = await consentRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.consentType).sort()).toEqual([
      'audio_cognitive_monitoring',
      'biometric_verification',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        caregiverId: caregiver.id,
        dependantId: null,
        grantedBy: caregiver.id,
        revokedAt: null,
      });
    }
  });

  it("records a family member's consent for the active dependants they're the primary contact of", async () => {
    const familyMember = await createTestUser('fm-1', 'family_member', '+254700000002');
    const other = await createTestUser('fm-2', 'family_member', '+254700000003');
    const primary = await createTestDependant(familyMember.id);
    const alsoPrimary = await createTestDependant(familyMember.id);
    const linkedOnly = await createTestDependant(other.id);
    const deactivated = await createTestDependant(familyMember.id, 'deactivated');
    await linkFamilyMember(primary, familyMember.id, true);
    await linkFamilyMember(alsoPrimary, familyMember.id, true);
    await linkFamilyMember(linkedOnly, other.id, true);
    await linkFamilyMember(linkedOnly, familyMember.id, false);
    await linkFamilyMember(deactivated, familyMember.id, true);

    const response = await request(app)
      .post('/terms/current/accept')
      .set('x-test-auth', testAuthHeader('fm-1', 'family_member'))
      .send(acceptBody(CURRENT_TERMS.family_member.version));
    expect(response.status).toBe(200);

    const rows = await consentRows();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.dependantId))).toEqual(new Set([primary, alsoPrimary]));
    expect(rows.every((row) => row.grantedBy === familyMember.id)).toBe(true);
  });

  it('never duplicates an active consent, but grants again after one was revoked', async () => {
    const caregiver = await createTestCaregiver('cg-1', '+254700000001');
    const supervisor = await createTestUser('sup-1', 'supervisor', '+254700000009');
    // Already consented to photo verification (e.g. recorded by a supervisor); audio was granted
    // once and later withdrawn.
    await getDb()
      .insert(schema.consentRecords)
      .values([
        {
          subjectType: 'caregiver',
          caregiverId: caregiver.id,
          consentType: 'biometric_verification',
          grantedBy: supervisor.id,
        },
        {
          subjectType: 'caregiver',
          caregiverId: caregiver.id,
          consentType: 'audio_cognitive_monitoring',
          grantedBy: supervisor.id,
          revokedAt: new Date('2026-09-20T08:00:00Z'),
        },
      ]);

    for (let i = 0; i < 2; i++) {
      const response = await request(app)
        .post('/terms/current/accept')
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver'))
        .send(acceptBody(CURRENT_TERMS.caregiver.version));
      expect(response.status).toBe(200);
    }

    const active = (await consentRows()).filter((row) => row.revokedAt === null);
    expect(active.map((row) => [row.consentType, row.grantedBy]).sort()).toEqual([
      ['audio_cognitive_monitoring', caregiver.id],
      ['biometric_verification', supervisor.id],
    ]);
  });
  it('asks someone who accepted v1 again, since v2 adds the consents', async () => {
    const user = await createTestCaregiver('cg-1', '+254700000001');
    expect(CURRENT_TERMS.caregiver.version).not.toBe('1');
    await getDb()
      .insert(schema.termsAcceptances)
      .values({ userId: user.id, document: 'caregiver', version: '1' });
    const current = termsBody(
      await request(app)
        .get('/terms/current')
        .set('x-test-auth', testAuthHeader('cg-1', 'caregiver')),
    );
    expect(current.acceptedAt).toBeNull();
  });
});

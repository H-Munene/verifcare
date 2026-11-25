// Voice enrolment against a real Postgres, with S3 and the voice Lambda faked: who may enrol whom,
// consent, too little speech, and replacing a voiceprint.

import { eq } from 'drizzle-orm';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, UserRole } from '../auth/verifier.js';
import * as schema from '../db/schema.js';
import {
  getDb,
  getTestDatabaseUrl,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../db/testSupport.js';
import type { VisitAudioStorage } from '../db/visitAudioStorage.js';
import { createFakeVoiceService, type VoiceService } from '../voiceService.js';
import { createVoiceEnrollmentsRouter } from './voiceEnrollments.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function auth(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

describe.skipIf(!hasTestDb)('voice enrolment (real Postgres)', () => {
  let app: Express;
  let enrol: ReturnType<typeof vi.fn<VoiceService['enrol']>>;
  let remove: ReturnType<typeof vi.fn<VoiceService['remove']>>;
  let caregiverId: string;
  let dependantId: string;
  let supervisorId: string;
  const caregiver = auth('cg-1', 'caregiver');
  const family = auth('fam-1', 'family_member');

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  async function addUser(sub: string, role: UserRole, phoneNumber: string) {
    const [row] = await getDb()
      .insert(schema.users)
      .values({ cognitoSub: sub, fullName: sub, phoneNumber, role })
      .returning();
    return row!;
  }

  async function grantVoiceConsent(subject: { caregiverId?: string; dependantId?: string }) {
    await getDb()
      .insert(schema.consentRecords)
      .values({
        subjectType: subject.caregiverId ? 'caregiver' : 'dependant',
        ...subject,
        consentType: 'voice_verification',
        grantedBy: supervisorId,
      });
  }

  beforeEach(async () => {
    await truncateAllTables();
    const storage: VisitAudioStorage = {
      createUploadUrl: (prefix) =>
        Promise.resolve({
          uploadUrl: 'https://s3.example/upload',
          s3Key: `${prefix}sample.m4a`,
          expiresAt: new Date('2026-11-13T09:05:00Z'),
        }),
      objectSize: () => Promise.resolve(600_000),
      createPlaybackUrl: () => Promise.reject(new Error('not used')),
    };
    enrol = vi
      .fn<VoiceService['enrol']>()
      .mockResolvedValue({ enrolled: true, speechSeconds: 28, modelRevision: 'test' });
    remove = vi.fn<VoiceService['remove']>().mockResolvedValue();
    app = express();
    app.use(express.json());
    app.locals.db = getDb();
    const requireAuth: express.RequestHandler = (req, _res, next) => {
      req.auth = JSON.parse(
        Buffer.from(req.headers['x-test-auth'] as string, 'base64url').toString('utf8'),
      ) as AuthenticatedUser;
      next();
    };
    app.use(
      '/voice-enrollments',
      createVoiceEnrollmentsRouter({
        requireAuth,
        storage,
        voice: createFakeVoiceService({ enrol, remove }),
      }),
    );

    supervisorId = (await addUser('sup-1', 'supervisor', '+254700000001')).id;
    caregiverId = (await addUser('cg-1', 'caregiver', '+254700000002')).id;
    await getDb().insert(schema.caregivers).values({ userId: caregiverId });
    const familyUser = await addUser('fam-1', 'family_member', '+254700000003');
    await addUser('fam-2', 'family_member', '+254700000004');
    const [dependant] = await getDb()
      .insert(schema.dependants)
      .values({
        fullName: 'Test Dependant',
        dob: '1950-01-01',
        geofenceLat: -1.28,
        geofenceLng: 36.81,
        geofenceRadiusMeters: 100,
        registeredBy: supervisorId,
      })
      .returning();
    dependantId = dependant!.id;
    await getDb().insert(schema.dependantFamilyMembers).values({
      dependantId,
      familyMemberUserId: familyUser.id,
      isPrimaryContact: false,
      addedBy: supervisorId,
    });
  });

  const enrolDependant = (who = family, s3Key = `enrol/dependant/${dependantId}/sample.m4a`) =>
    request(app)
      .post(`/voice-enrollments/dependants/${dependantId}`)
      .set('x-test-auth', who)
      .send({ s3Key });
  const enrolments = () => getDb().select().from(schema.voiceEnrollments);

  it('enrols a dependant with voice consent, and reports it', async () => {
    await grantVoiceConsent({ dependantId });

    const upload = await request(app)
      .post(`/voice-enrollments/dependants/${dependantId}/upload-url`)
      .set('x-test-auth', family);
    expect(upload.status).toBe(201);
    expect((upload.body as { s3Key: string }).s3Key).toBe(
      `enrol/dependant/${dependantId}/sample.m4a`,
    );

    expect((await enrolDependant()).status).toBe(201);
    const [input] = enrol.mock.calls[0]!;
    expect(input.audioKey).toBe(`enrol/dependant/${dependantId}/sample.m4a`);
    expect(input.voiceprintKey).toMatch(new RegExp(`^dependant/${dependantId}/.+\\.npy$`));
    const status = await request(app)
      .get(`/voice-enrollments/dependants/${dependantId}`)
      .set('x-test-auth', family);
    expect(status.body).toMatchObject({ enrolled: true, speechSeconds: 28 });
  });

  it('no longer enrols caregivers (since 2026-11-24)', async () => {
    await grantVoiceConsent({ caregiverId });

    for (const path of ['/voice-enrollments/me', '/voice-enrollments/me/upload-url']) {
      const response = await request(app).post(path).set('x-test-auth', caregiver).send({});
      expect(response.status).toBe(404);
    }
    const status = await request(app)
      .get(`/voice-enrollments/caregivers/${caregiverId}`)
      .set('x-test-auth', auth('sup-1', 'supervisor'));
    expect(status.status).toBe(404);
  });

  it('refuses enrolment without voice consent, or with a key for someone else', async () => {
    expect((await enrolDependant()).status).toBe(403);

    await grantVoiceConsent({ dependantId });
    expect((await enrolDependant(family, `enrol/dependant/someone-else/sample.m4a`)).status).toBe(
      400,
    );
    expect(enrol).not.toHaveBeenCalled();
    expect(await enrolments()).toHaveLength(0);
  });

  it('asks for another recording when too little speech was heard', async () => {
    await grantVoiceConsent({ dependantId });
    enrol.mockResolvedValueOnce({ enrolled: false, speechSeconds: 11 });

    const response = await enrolDependant();

    expect(response.status).toBe(422);
    expect((response.body as { detail: string }).detail).toMatch(/11 seconds/);
    expect(await enrolments()).toHaveLength(0);
  });

  it('asks for the new voiceprint to be deleted when enrolment fails part way', async () => {
    await grantVoiceConsent({ dependantId });
    enrol.mockRejectedValueOnce(new Error('timed out'));

    expect((await enrolDependant()).status).toBe(500);

    const [input] = enrol.mock.calls[0]!;
    expect(remove).toHaveBeenCalledWith({ voiceprintKey: input.voiceprintKey });
    expect(await enrolments()).toHaveLength(0);
  });

  it('replaces a voiceprint on re-enrolment and deletes the old one', async () => {
    await grantVoiceConsent({ dependantId });
    await enrolDependant();
    const [first] = await enrolments();

    await enrolDependant();

    const rows = await enrolments();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.removedAt === null)).toHaveLength(1);
    expect(remove).toHaveBeenCalledWith({ voiceprintKey: first!.voiceprintKey });
    const audit = await getDb()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'voice_enrollment.replace'));
    expect(audit).toHaveLength(1);
  });

  it('lets a linked family member enrol the dependant, and nobody else', async () => {
    await grantVoiceConsent({ dependantId });

    expect((await enrolDependant(auth('fam-2', 'family_member'))).status).toBe(403);
    expect((await enrolDependant(caregiver)).status).toBe(403);
    expect((await enrolDependant()).status).toBe(201);
    expect(await enrolments()).toMatchObject([{ subjectType: 'dependant', dependantId }]);
  });

  it('shows supervisors who is enrolled, but not the voiceprint', async () => {
    await grantVoiceConsent({ dependantId });
    await enrolDependant();
    const supervisor = auth('sup-1', 'supervisor');

    const dependant = await request(app)
      .get(`/voice-enrollments/dependants/${dependantId}`)
      .set('x-test-auth', supervisor);

    expect(Object.keys(dependant.body as object).sort()).toEqual([
      'enrolled',
      'enrolledAt',
      'speechSeconds',
    ]);
    expect(dependant.body).toMatchObject({ enrolled: true, speechSeconds: 28 });
    expect(
      (
        await request(app)
          .get(`/voice-enrollments/dependants/${dependantId}`)
          .set('x-test-auth', auth('fam-2', 'family_member'))
      ).status,
    ).toBe(403);
  });
});

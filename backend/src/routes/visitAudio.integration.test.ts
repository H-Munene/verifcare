// The visit's two recordings against a real Postgres, with S3 and the voice Lambda faked: who may
// upload, the voice check on each, who may listen, and the audit trail of listening.

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
import { createVisitAudioRouter } from './visitAudio.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function auth(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

describe.skipIf(!hasTestDb)('visit audio (real Postgres)', () => {
  let app: Express;
  let storage: {
    createUploadUrl: ReturnType<typeof vi.fn<VisitAudioStorage['createUploadUrl']>>;
    objectSize: ReturnType<typeof vi.fn<VisitAudioStorage['objectSize']>>;
    createPlaybackUrl: ReturnType<typeof vi.fn<VisitAudioStorage['createPlaybackUrl']>>;
  };
  let verify: ReturnType<typeof vi.fn<VoiceService['verify']>>;
  let visitId: string;
  let dependantId: string;
  let supervisorId: string;
  let now: Date;
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

  // The dependant's consent; only the dependant is recorded since 2026-11-24.
  async function grant(
    _who: 'dependant',
    consentType: 'visit_audio' | 'voice_verification' = 'visit_audio',
  ) {
    await getDb().insert(schema.consentRecords).values({
      subjectType: 'dependant',
      dependantId,
      consentType,
      grantedBy: supervisorId,
    });
  }

  async function grantAudioConsent() {
    await grant('dependant');
  }

  async function enrol(who: 'dependant') {
    await grant(who, 'voice_verification');
    await getDb()
      .insert(schema.voiceEnrollments)
      .values({
        subjectType: who,
        dependantId,
        voiceprintKey: `${who}/voiceprint.npy`,
        speechSeconds: 30,
        modelRevision: 'test',
        enrolledBy: supervisorId,
      });
  }

  beforeEach(async () => {
    await truncateAllTables();
    now = new Date('2026-11-09T09:30:00Z');
    storage = {
      createUploadUrl: vi.fn<VisitAudioStorage['createUploadUrl']>().mockImplementation((prefix) =>
        Promise.resolve({
          uploadUrl: 'https://s3.example/upload',
          s3Key: `${prefix}clip.m4a`,
          expiresAt: new Date('2026-11-09T09:35:00Z'),
        }),
      ),
      objectSize: vi.fn<VisitAudioStorage['objectSize']>().mockResolvedValue(400_000),
      createPlaybackUrl: vi.fn<VisitAudioStorage['createPlaybackUrl']>().mockResolvedValue({
        url: 'https://s3.example/play',
        expiresAt: new Date('2026-11-09T09:35:00Z'),
      }),
    };
    verify = vi.fn<VoiceService['verify']>().mockResolvedValue({
      result: 'match',
      score: 0.71,
      speechSeconds: 9,
      threshold: 0.5,
      modelRevision: 'test',
    });
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
      '/visit-schedules',
      createVisitAudioRouter({
        requireAuth,
        storage,
        voice: createFakeVoiceService({ verify }),
        now: () => now,
      }),
    );

    const supervisor = await addUser('sup-1', 'supervisor', '+254700000001');
    supervisorId = supervisor.id;
    const caregiverUser = await addUser('cg-1', 'caregiver', '+254700000002');
    await getDb().insert(schema.caregivers).values({ userId: caregiverUser.id });
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
        registeredBy: supervisor.id,
      })
      .returning();
    dependantId = dependant!.id;
    await getDb().insert(schema.dependantFamilyMembers).values({
      dependantId,
      familyMemberUserId: familyUser.id,
      isPrimaryContact: true,
      addedBy: supervisor.id,
    });
    const [visit] = await getDb()
      .insert(schema.visitSchedules)
      .values({
        caregiverId: caregiverUser.id,
        dependantId,
        scheduledStart: new Date('2026-11-09T09:00:00Z'),
        scheduledEnd: new Date('2026-11-09T10:00:00Z'),
        status: 'in_progress',
        createdBy: supervisor.id,
      })
      .returning();
    visitId = visit!.id;
    await getDb()
      .insert(schema.verificationEvents)
      .values({ visitScheduleId: visitId, checkinAt: new Date('2026-11-09T09:05:00Z') });
  });

  const upload = (who = caregiver, role = 'dependant') =>
    request(app)
      .post(`/visit-schedules/${visitId}/audio/${role}/upload-url`)
      .set('x-test-auth', who);
  const confirm = (body: Record<string, unknown> = {}, who = caregiver, role = 'dependant') =>
    request(app)
      .post(`/visit-schedules/${visitId}/audio/${role}`)
      .set('x-test-auth', who)
      .send({ s3Key: `${visitId}/${role}/clip.m4a`, durationSeconds: 30, ...body });
  const listen = (who = family) =>
    request(app).get(`/visit-schedules/${visitId}/audio`).set('x-test-auth', who);
  const requirement = () =>
    request(app).get(`/visit-schedules/${visitId}/audio/requirement`).set('x-test-auth', caregiver);
  const checks = async () =>
    (
      await getDb()
        .select({
          role: schema.audioRecords.role,
          result: schema.voiceChecks.result,
          score: schema.voiceChecks.score,
        })
        .from(schema.voiceChecks)
        .innerJoin(
          schema.audioRecords,
          eq(schema.audioRecords.id, schema.voiceChecks.audioRecordId),
        )
    ).sort((a, b) => a.role.localeCompare(b.role));

  describe('recording', () => {
    it("reports whether the dependant's recording is needed, following their consent", async () => {
      expect((await requirement()).body).toEqual({
        dependant: { required: false, recorded: false },
      });

      await grantAudioConsent();
      expect((await requirement()).body).toEqual({
        dependant: { required: true, recorded: false },
      });
      await confirm();
      expect((await requirement()).body).toEqual({
        dependant: { required: true, recorded: true },
      });
    });

    it("refuses the dependant's recording without their consent", async () => {
      expect((await upload()).status).toBe(403);
      expect((await confirm()).status).toBe(403);
      expect(await getDb().select().from(schema.audioRecords)).toHaveLength(0);
    });

    it('no longer records the caregiver (since 2026-11-24)', async () => {
      await grantAudioConsent();

      expect((await upload(caregiver, 'caregiver')).status).toBe(400);
      expect((await confirm({}, caregiver, 'caregiver')).status).toBe(400);
    });

    it('stores one recording per visit, even if the caregiver retries', async () => {
      await grantAudioConsent();

      expect((await confirm()).status).toBe(201);
      expect((await confirm({ durationSeconds: 28 })).status).toBe(201);

      const rows = await getDb().select().from(schema.audioRecords);
      expect(rows.map((r) => [r.role, r.durationSeconds])).toEqual([['dependant', 28]]);
    });

    it('only accepts a recording during the visit', async () => {
      await grantAudioConsent();
      await getDb().update(schema.visitSchedules).set({ status: 'completed' });

      expect((await upload()).status).toBe(409);
      expect((await confirm()).status).toBe(409);
    });

    it('refuses another caregiver and other roles', async () => {
      await grantAudioConsent();
      const other = await addUser('cg-2', 'caregiver', '+254700000005');
      await getDb().insert(schema.caregivers).values({ userId: other.id });

      expect((await upload(auth('cg-2', 'caregiver'))).status).toBe(403);
      expect((await upload(family)).status).toBe(403);
      expect((await upload(auth('sup-1', 'supervisor'))).status).toBe(403);
    });

    it("refuses a key that isn't this visit's or this person's, and an unknown role", async () => {
      await grantAudioConsent();

      expect((await confirm({ s3Key: 'someone-else/clip.m4a' })).status).toBe(400);
      expect((await confirm({ s3Key: `${visitId}/caregiver/clip.m4a` })).status).toBe(400);
      expect((await upload(caregiver, 'family')).status).toBe(400);
    });

    it('refuses a recording that was never uploaded, is empty, or is far too big', async () => {
      await grantAudioConsent();

      storage.objectSize.mockResolvedValueOnce(null);
      expect((await confirm()).status).toBe(400);
      storage.objectSize.mockResolvedValueOnce(0);
      expect((await confirm()).status).toBe(422);
      storage.objectSize.mockResolvedValueOnce(50_000_000);
      expect((await confirm()).status).toBe(422);
    });

    it('refuses a length outside 10 to 31 seconds', async () => {
      await grantAudioConsent();

      expect((await confirm({ durationSeconds: 9 })).status).toBe(400);
      expect((await confirm({ durationSeconds: 32 })).status).toBe(400);
      expect((await confirm({ durationSeconds: 10 })).status).toBe(201);
    });
  });

  describe('voice check', () => {
    beforeEach(grantAudioConsent);

    it("checks the recording against the dependant's voiceprint and returns the result", async () => {
      await enrol('dependant');
      const response = await confirm();

      expect(verify.mock.calls.map(([input]) => input)).toEqual([
        { audioKey: `${visitId}/dependant/clip.m4a`, voiceprintKey: 'dependant/voiceprint.npy' },
      ]);
      expect(await checks()).toEqual([{ role: 'dependant', result: 'match', score: 0.71 }]);
      // Shown to the caregiver straight away, so they can record again after a failed check.
      expect(response.body).toMatchObject({
        voiceCheck: { result: 'match', score: 0.71, threshold: 0.5 },
      });
    });

    it('does not analyse a dependant without voice consent, or who is not enrolled', async () => {
      const noConsent = await confirm();
      expect(noConsent.body).toMatchObject({
        voiceCheck: { result: 'no_consent', score: null, threshold: null },
      });

      await grant('dependant', 'voice_verification');
      const notEnrolled = await confirm();
      expect(notEnrolled.body).toMatchObject({
        voiceCheck: { result: 'not_enrolled', score: null },
      });
      expect(verify).not.toHaveBeenCalled();
    });

    it('keeps the recording and marks the check unavailable when the voice service fails', async () => {
      await enrol('dependant');
      verify.mockRejectedValueOnce(new Error('timed out'));

      const response = await confirm();
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ voiceCheck: { result: 'unavailable' } });
      expect(await checks()).toEqual([{ role: 'dependant', result: 'unavailable', score: null }]);
    });

    it('replaces the check when the caregiver re-records', async () => {
      await enrol('dependant');
      verify.mockResolvedValueOnce({
        result: 'mismatch',
        score: 0.2,
        speechSeconds: 9,
        threshold: 0.5,
        modelRevision: 'test',
      });
      await confirm();
      await confirm({ durationSeconds: 25 });

      expect(await checks()).toEqual([{ role: 'dependant', result: 'match', score: 0.71 }]);
    });
  });

  describe('listening', () => {
    beforeEach(async () => {
      await grantAudioConsent();
      await confirm();
    });

    it("gives a linked family member the dependant's recording and logs that they listened", async () => {
      const response = await listen();

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ url: 'https://s3.example/play', durationSeconds: 30 });
      expect(storage.createPlaybackUrl).toHaveBeenCalledWith(`${visitId}/dependant/clip.m4a`);
      const entries = await getDb()
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'visit_audio.listen'));
      expect(entries).toHaveLength(1);
    });

    it('never gives a supervisor or the caregiver a way to listen', async () => {
      expect((await listen(auth('sup-1', 'supervisor'))).status).toBe(403);
      expect((await listen(caregiver)).status).toBe(403);
      expect(storage.createPlaybackUrl).not.toHaveBeenCalled();
    });

    it("refuses a family member who isn't linked to this dependant", async () => {
      expect((await listen(auth('fam-2', 'family_member'))).status).toBe(403);
    });

    it('reports a recording past the 90-day limit as gone', async () => {
      now = new Date('2027-02-08T09:31:00Z');

      expect((await listen()).status).toBe(410);
      expect(storage.createPlaybackUrl).not.toHaveBeenCalled();
    });

    it('returns 404 when the dependant has no recording', async () => {
      await getDb().delete(schema.voiceChecks);
      await getDb().delete(schema.audioRecords).where(eq(schema.audioRecords.role, 'dependant'));

      expect((await listen()).status).toBe(404);
    });
  });
});

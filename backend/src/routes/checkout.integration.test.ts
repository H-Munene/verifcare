// Check-out against a real Postgres: what the request requires, who may show the family's code,
// scanning and typing it, the override, and the limits on codes.

import { eq } from 'drizzle-orm';
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
import { createCheckinCodeRouter } from './checkinCode.js';
import { createCheckoutRouter } from './checkout.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function auth(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

const home = { geofenceLat: -1.28, geofenceLng: 36.81 };
const atHome = { gpsLat: home.geofenceLat, gpsLng: home.geofenceLng };
const familyAtHome = { ...atHome, accuracyMeters: 5, isMockLocation: false };
// ~222 m north of the home, outside its 100 m radius.
const away = { gpsLat: home.geofenceLat + 0.002, gpsLng: home.geofenceLng };

interface CodeBody {
  token: string;
  code: string;
}

describe.skipIf(!hasTestDb)('check-out (real Postgres)', () => {
  let app: Express;
  let visitId: string;
  let dependantId: string;
  let caregiverId: string;
  let supervisorId: string;
  let familyId: string;
  let now: Date;
  const caregiver = auth('cg-1', 'caregiver');
  const family = auth('fam-1', 'family_member');
  const otherFamily = auth('fam-2', 'family_member');

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

  beforeEach(async () => {
    await truncateAllTables();
    now = new Date();
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
      createCheckinCodeRouter({
        requireAuth,
        geofenceAccuracyThresholdMeters: 20,
        qrTokenTtlSeconds: 60,
      }),
    );
    app.use('/visit-schedules', createCheckoutRouter({ requireAuth, now: () => now }));

    supervisorId = (await addUser('sup-1', 'supervisor', '+254700000001')).id;
    caregiverId = (await addUser('cg-1', 'caregiver', '+254700000002')).id;
    await getDb().insert(schema.caregivers).values({ userId: caregiverId });
    familyId = (await addUser('fam-1', 'family_member', '+254700000003')).id;
    const otherFamilyId = (await addUser('fam-2', 'family_member', '+254700000004')).id;
    const [dependant] = await getDb()
      .insert(schema.dependants)
      .values({
        fullName: 'Test Dependant',
        dob: '1950-01-01',
        ...home,
        geofenceRadiusMeters: 100,
        registeredBy: supervisorId,
      })
      .returning();
    dependantId = dependant!.id;
    for (const [id, primary] of [
      [familyId, true],
      [otherFamilyId, false],
    ] as const) {
      await getDb().insert(schema.dependantFamilyMembers).values({
        dependantId,
        familyMemberUserId: id,
        isPrimaryContact: primary,
        addedBy: supervisorId,
      });
    }
    const [visit] = await getDb()
      .insert(schema.visitSchedules)
      .values({
        caregiverId,
        dependantId,
        scheduledStart: new Date(now.getTime() - 30 * 60_000),
        scheduledEnd: new Date(now.getTime() + 30 * 60_000),
        status: 'in_progress',
        createdBy: supervisorId,
      })
      .returning();
    visitId = visit!.id;
    // Checked in by scanning fam-1's code.
    await getDb()
      .insert(schema.verificationEvents)
      .values({
        visitScheduleId: visitId,
        checkinAt: new Date(now.getTime() - 25 * 60_000),
        checkinMethod: 'qr',
        qrFamilyMemberUserId: familyId,
      });
  });

  const requestCheckout = (body: Record<string, unknown> = {}) =>
    request(app)
      .post(`/visit-schedules/${visitId}/checkout/request`)
      .set('x-test-auth', caregiver)
      .send({ ...atHome, ...body });
  const issueCode = (who = family, position = familyAtHome) =>
    request(app)
      .post(`/visit-schedules/${visitId}/checkout/qr`)
      .set('x-test-auth', who)
      .send(position);
  const scan = (token: string, position = atHome) =>
    request(app)
      .post(`/visit-schedules/${visitId}/checkout/qr-scan`)
      .set('x-test-auth', caregiver)
      .send({ ...position, token });
  const type = (code: string) =>
    request(app)
      .post(`/visit-schedules/${visitId}/checkout/code`)
      .set('x-test-auth', caregiver)
      .send({ ...atHome, code });
  const override = (body: Record<string, unknown>) =>
    request(app)
      .post(`/visit-schedules/${visitId}/checkout/override`)
      .set('x-test-auth', caregiver)
      .send({ ...atHome, ...body });
  const event = async () =>
    (
      await getDb()
        .select()
        .from(schema.verificationEvents)
        .where(eq(schema.verificationEvents.visitScheduleId, visitId))
    )[0]!;
  const status = async () =>
    (
      await getDb()
        .select({ status: schema.visitSchedules.status })
        .from(schema.visitSchedules)
        .where(eq(schema.visitSchedules.id, visitId))
    )[0]!.status;
  async function grantAudio(subjectType: 'caregiver' | 'dependant') {
    await getDb()
      .insert(schema.consentRecords)
      .values({
        subjectType,
        caregiverId: subjectType === 'caregiver' ? caregiverId : null,
        dependantId: subjectType === 'dependant' ? dependantId : null,
        consentType: 'visit_audio',
        grantedBy: supervisorId,
      });
  }
  async function record(role: schema.RecordingRole) {
    await getDb()
      .insert(schema.audioRecords)
      .values({
        verificationEventId: visitId,
        role,
        s3Key: `${visitId}/${role}/a.m4a`,
        durationSeconds: 20,
      });
  }

  describe('request', () => {
    it("refuses from outside the home's radius, naming the distance", async () => {
      const response = await requestCheckout(away);

      expect(response.status).toBe(422);
      expect((response.body as { detail: string }).detail).toContain('222 m');
      expect((await event()).checkoutRequestedAt).toBeNull();
    });

    it('needs every required task addressed', async () => {
      await getDb().insert(schema.dependantCareTasks).values({
        dependantId,
        title: 'Give medication',
        required: true,
        createdBy: supervisorId,
      });

      const response = await requestCheckout();

      expect(response.status).toBe(409);
      expect((response.body as { detail: string }).detail).toContain('Give medication');
    });

    it("needs the dependant's recording or a reason, and not the caregiver's (since 2026-11-24)", async () => {
      await grantAudio('caregiver');
      await grantAudio('dependant');

      expect((await requestCheckout()).body).toMatchObject({
        failureReason: 'dependant_recording_required',
      });
      expect((await requestCheckout({ audioSkipReason: 'other' })).status).toBe(400);

      const response = await requestCheckout({ audioSkipReason: 'dependant_unwell_or_asleep' });

      expect(response.status).toBe(200);
      expect(await event()).toMatchObject({ audioSkipReason: 'dependant_unwell_or_asleep' });
      expect((await event()).checkoutRequestedAt).not.toBeNull();
      expect(await status()).toBe('in_progress');
    });

    it('ignores a reason when the dependant was recorded', async () => {
      await grantAudio('caregiver');
      await grantAudio('dependant');
      await record('dependant');

      expect((await requestCheckout({ audioSkipReason: 'dependant_declined' })).status).toBe(200);
      expect((await event()).audioSkipReason).toBeNull();
    });

    it('is only for the assigned caregiver, during the visit', async () => {
      const other = await request(app)
        .post(`/visit-schedules/${visitId}/checkout/request`)
        .set('x-test-auth', family)
        .send(atHome);
      expect(other.status).toBe(403);

      await getDb().update(schema.visitSchedules).set({ status: 'completed' });
      expect((await requestCheckout()).status).toBe(409);
    });
  });

  describe("the family's code", () => {
    it('is only shown once the caregiver has asked to check out', async () => {
      expect((await issueCode()).status).toBe(409);

      await requestCheckout();
      const response = await issueCode();

      expect(response.status).toBe(201);
      expect((response.body as CodeBody).code).toMatch(/^\d{6}$/);
    });

    it('is shown only by the family member whose code started the visit', async () => {
      await requestCheckout();

      expect((await issueCode(otherFamily)).status).toBe(403);
      expect((await issueCode(auth('cg-1', 'caregiver'))).status).toBe(403);
    });

    it('can be shown by any linked family member when a supervisor started the visit', async () => {
      await getDb()
        .update(schema.verificationEvents)
        .set({ checkinMethod: 'supervisor_override', qrFamilyMemberUserId: null });
      expect((await requestCheckout()).body).toMatchObject({ status: 'awaiting_confirmation' });

      const response = await issueCode(otherFamily);
      expect((response.body as { detail?: string }).detail).toBeUndefined();
      expect(response.status).toBe(201);
    });

    it("needs the family member's phone at the home", async () => {
      await requestCheckout();

      expect((await issueCode(family, { ...familyAtHome, ...away })).status).toBe(422);
      expect((await issueCode(family, { ...familyAtHome, isMockLocation: true })).status).toBe(422);
    });
  });

  describe('confirming', () => {
    beforeEach(async () => {
      await requestCheckout();
    });

    it('completes the visit when the caregiver scans the QR code', async () => {
      const { token } = (await issueCode()).body as CodeBody;

      const response = await scan(token);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'completed', checkoutMethod: 'qr' });
      expect(await status()).toBe('completed');
      expect(await event()).toMatchObject({
        checkoutMethod: 'qr',
        checkoutFamilyMemberUserId: familyId,
        checkoutDistanceFromGeofenceMeters: 0,
        checkoutOverrideReason: null,
      });
    });

    it('completes the visit when the caregiver types the 6 digits', async () => {
      const { code } = (await issueCode()).body as CodeBody;

      const response = await type(code);

      expect(response.status).toBe(200);
      expect(await event()).toMatchObject({
        checkoutMethod: 'code',
        checkoutFamilyMemberUserId: familyId,
      });
    });

    it('refuses a used, expired or check-in code', async () => {
      const first = (await issueCode()).body as CodeBody;
      now = new Date(now.getTime() + 61_000);
      expect((await scan(first.token)).body).toMatchObject({ failureReason: 'expired_code' });
      expect((await type(first.code)).body).toMatchObject({ failureReason: 'expired_code' });

      const [checkinCode] = await getDb()
        .select()
        .from(schema.checkinQrTokens)
        .where(eq(schema.checkinQrTokens.purpose, 'checkout'));
      await getDb()
        .update(schema.checkinQrTokens)
        .set({ purpose: 'checkin', expiresAt: new Date(now.getTime() + 60_000) })
        .where(eq(schema.checkinQrTokens.id, checkinCode!.id));
      expect((await scan(first.token)).body).toMatchObject({ failureReason: 'invalid_code' });
      expect(await status()).toBe('in_progress');
    });

    it('refuses a scan from outside the radius', async () => {
      const { token } = (await issueCode()).body as CodeBody;

      expect((await scan(token, away)).status).toBe(422);
      expect(await status()).toBe('in_progress');
    });

    it('stops accepting typed codes after 5 wrong ones', async () => {
      const { code } = (await issueCode()).body as CodeBody;
      const wrong = code === '000000' ? '111111' : '000000';

      for (let i = 0; i < 5; i++) {
        expect((await type(wrong)).status).toBe(422);
      }
      expect((await type(code)).status).toBe(429);
      expect((await scan(((await issueCode()).body as CodeBody).token)).status).toBe(200);
    });

    it('needs check-out to have been requested first', async () => {
      await getDb().update(schema.verificationEvents).set({ checkoutRequestedAt: null });

      expect((await override({ reason: 'no_family_member_present' })).status).toBe(409);
    });
  });

  describe('override', () => {
    beforeEach(async () => {
      await requestCheckout();
    });

    it('completes the visit at once, keeping the reason for supervisors', async () => {
      const response = await override({ reason: 'other', note: 'Family phone battery was dead' });

      expect(response.status).toBe(200);
      expect(await status()).toBe('completed');
      expect(await event()).toMatchObject({
        checkoutMethod: 'override',
        checkoutOverrideReason: 'other',
        checkoutOverrideNote: 'Family phone battery was dead',
        checkoutFamilyMemberUserId: null,
      });
      const [audit] = await getDb()
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'visit.checkout'));
      expect(audit?.metadata).toMatchObject({ method: 'override', reason: 'other' });
    });

    it("needs a note when the reason is 'other', and refuses a second check-out", async () => {
      expect((await override({ reason: 'other' })).status).toBe(400);
      expect((await override({ reason: 'camera_or_code_problem' })).status).toBe(200);
      expect((await override({ reason: 'camera_or_code_problem' })).status).toBe(409);
    });
  });
});

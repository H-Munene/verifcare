// Day plans and missed-visit recovery against a real Postgres: overlap constraints, concurrent
// acceptance and the recovery state machine are database behaviour, not something a mock can show.

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
import { MAX_OFFERS, runVisitRecovery } from '../recovery.js';
import { createRecoveryOffersRouter } from './recoveryOffers.js';
import { createVisitPlansRouter } from './visitPlans.js';

const hasTestDb = Boolean(getTestDatabaseUrl());

function auth(sub: string, role: UserRole): string {
  const user: AuthenticatedUser = { sub, role, email: undefined };
  return Buffer.from(JSON.stringify(user)).toString('base64url');
}

const NOW = new Date('2026-11-10T06:30:00Z'); // 09:30 in Nairobi
const SUPERVISOR = auth('sup', 'supervisor');
const HOME = { lat: -1.29, lng: 36.82 };

let counter = 0;

async function addUser(sub: string, role: UserRole) {
  counter += 1;
  const [row] = await getDb()
    .insert(schema.users)
    .values({
      cognitoSub: sub,
      fullName: sub,
      phoneNumber: `+2547${String(10_000_000 + counter)}`,
      role,
    })
    .returning();
  return row!;
}

async function addCaregiver(
  sub: string,
  base: { lat: number; lng: number } | null,
  options: { consent?: boolean; active?: boolean } = {},
) {
  const { consent = true, active = true } = options;
  const user = await addUser(sub, 'caregiver');
  await getDb()
    .insert(schema.caregivers)
    .values({ userId: user.id, baseLat: base?.lat, baseLng: base?.lng, active });
  if (consent) {
    await getDb().insert(schema.consentRecords).values({
      subjectType: 'caregiver',
      caregiverId: user.id,
      consentType: 'location_verification',
      grantedBy: user.id,
    });
  }
  return user;
}

async function addDependant(
  name: string,
  at: { lat: number; lng: number },
  registeredBy: string,
  consent = true,
) {
  const [row] = await getDb()
    .insert(schema.dependants)
    .values({
      fullName: name,
      dob: '1945-01-01',
      ward: 'KILELESHWA',
      homeAddressText: '12 Mugo Road',
      geofenceLat: at.lat,
      geofenceLng: at.lng,
      geofenceRadiusMeters: 100,
      registeredBy,
    })
    .returning();
  if (consent) {
    await getDb().insert(schema.consentRecords).values({
      subjectType: 'dependant',
      dependantId: row!.id,
      consentType: 'location_verification',
      grantedBy: registeredBy,
    });
  }
  return row!;
}

async function addVisit(
  caregiverId: string,
  dependantId: string,
  createdBy: string,
  start: Date,
  minutes = 60,
  status = 'scheduled',
) {
  const [row] = await getDb()
    .insert(schema.visitSchedules)
    .values({
      caregiverId,
      dependantId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + minutes * 60_000),
      status,
      createdBy,
    })
    .returning();
  return row!;
}

const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

async function visitById(id: string) {
  const [row] = await getDb()
    .select()
    .from(schema.visitSchedules)
    .where(eq(schema.visitSchedules.id, id));
  return row!;
}

async function offers() {
  return getDb().select().from(schema.visitRecoveryOffers);
}

async function cases() {
  return getDb().select().from(schema.visitRecoveryCases);
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.locals.db = getDb();
  const requireAuth: express.RequestHandler = (req, _res, next) => {
    req.auth = JSON.parse(
      Buffer.from(req.headers['x-test-auth'] as string, 'base64url').toString('utf8'),
    ) as AuthenticatedUser;
    next();
  };
  app.use('/visit-plans', createVisitPlansRouter({ requireAuth, now: () => NOW }));
  app.use('/recovery-offers', createRecoveryOffersRouter({ requireAuth, now: () => NOW }));
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ title: 'Internal Server Error', message: String(err) });
    },
  );
  return app;
}

interface PlanBody {
  id: string;
  status: string;
  clusters: {
    caregiverId: string;
    caregiverName: string;
    totalDistanceMeters: number;
    stops: { dependantId: string; dependantName: string; scheduledStart: string }[];
  }[];
  unplaced: { dependantName: string; reason: string }[];
  excludedCaregivers: { caregiverName: string; reason: string }[];
}

describe.skipIf(!hasTestDb)('day plans and recovery (real Postgres)', () => {
  let app: Express;
  let supervisorId: string;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    app = buildApp();
    supervisorId = (await addUser('sup', 'supervisor')).id;
  });

  describe('day plans', () => {
    const body = {
      date: '2026-11-11',
      shiftStart: '08:00',
      shiftEnd: '17:00',
      visitMinutes: 45,
    };
    const create = (overrides: Record<string, unknown> = {}) =>
      request(app)
        .post('/visit-plans')
        .set('x-test-auth', SUPERVISOR)
        .send({ ...body, ...overrides });
    const planOf = (response: request.Response) => response.body as PlanBody;

    async function twoNeighbourhoods() {
      const west = await addCaregiver('west', { lat: -1.29, lng: 36.74 });
      const east = await addCaregiver('east', { lat: -1.29, lng: 36.85 });
      for (const i of [0, 1, 2]) {
        await addDependant(`West ${i}`, { lat: -1.29 + i * 0.001, lng: 36.75 }, supervisorId);
        await addDependant(`East ${i}`, { lat: -1.29 + i * 0.001, lng: 36.84 }, supervisorId);
      }
      return { west, east };
    }

    it('drafts routes that give each neighbourhood to the nearest caregiver', async () => {
      await twoNeighbourhoods();

      const response = await create();

      expect(response.status).toBe(201);
      const plan = planOf(response);
      expect(plan.status).toBe('draft');
      for (const cluster of plan.clusters) {
        const expected = cluster.caregiverName === 'west' ? 'West' : 'East';
        expect(cluster.stops).toHaveLength(3);
        expect(cluster.stops.every((s) => s.dependantName.startsWith(expected))).toBe(true);
      }
    });

    it('creates no visits until it is published', async () => {
      await twoNeighbourhoods();

      await create();

      expect(await getDb().select().from(schema.visitSchedules)).toHaveLength(0);
    });

    it('publishes real visits in route order, once', async () => {
      await twoNeighbourhoods();
      const plan = planOf(await create());
      const publish = () =>
        request(app).post(`/visit-plans/${plan.id}/publish`).set('x-test-auth', SUPERVISOR);

      const first = await publish();
      const second = await publish();

      expect(first.status).toBe(200);
      expect(planOf(first).status).toBe('published');
      expect(second.status).toBe(409);
      const visits = await getDb().select().from(schema.visitSchedules);
      expect(visits).toHaveLength(6);
      expect(visits.map((v) => v.routeSequence).sort()).toEqual([1, 1, 2, 2, 3, 3]);
      expect(visits.every((v) => v.planClusterId !== null)).toBe(true);
    });

    it('explains who was left out, and why', async () => {
      await addCaregiver('ready', { lat: -1.29, lng: 36.8 });
      await addCaregiver('no-base', null);
      await addCaregiver('no-consent', { lat: -1.29, lng: 36.8 }, { consent: false });
      const busyCaregiver = await addCaregiver('busy', { lat: -1.29, lng: 36.8 });
      await addDependant('Fine', HOME, supervisorId);
      await addDependant('Unconsented', HOME, supervisorId, false);
      const booked = await addDependant('Booked', HOME, supervisorId);
      await addVisit(busyCaregiver.id, booked.id, supervisorId, new Date('2026-11-11T06:00:00Z'));

      const plan = planOf(await create());

      expect(plan.unplaced).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ dependantName: 'Unconsented', reason: 'no_consent' }),
          expect.objectContaining({ dependantName: 'Booked', reason: 'already_scheduled' }),
        ]),
      );
      expect(plan.excludedCaregivers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ caregiverName: 'no-base', reason: 'no_home_base' }),
          expect.objectContaining({ caregiverName: 'no-consent', reason: 'no_consent' }),
          expect.objectContaining({ caregiverName: 'busy', reason: 'already_scheduled' }),
        ]),
      );
      expect(plan.clusters.map((c) => c.caregiverName)).toEqual(['ready']);
    });

    it('reports stops that do not fit the shift', async () => {
      await addCaregiver('one', HOME);
      for (const i of [0, 1, 2]) {
        await addDependant(`D${i}`, { lat: HOME.lat + i * 0.001, lng: HOME.lng }, supervisorId);
      }

      const plan = planOf(await create({ shiftEnd: '09:00', visitMinutes: 45 }));

      expect(plan.clusters[0]!.stops).toHaveLength(1);
      expect(plan.unplaced.filter((u) => u.reason === 'shift_full')).toHaveLength(2);
    });

    it('recalculates times when a supervisor reorders stops', async () => {
      const { west } = await twoNeighbourhoods();
      const plan = planOf(await create());
      const clusters = plan.clusters.map((c) => ({
        caregiverId: c.caregiverId,
        dependantIds: c.stops.map((s) => s.dependantId),
      }));
      const westCluster = clusters.find((c) => c.caregiverId === west.id)!;
      const original = plan.clusters.find((c) => c.caregiverId === west.id)!;
      westCluster.dependantIds.reverse();

      const response = await request(app)
        .patch(`/visit-plans/${plan.id}`)
        .set('x-test-auth', SUPERVISOR)
        .send({ clusters });

      expect(response.status).toBe(200);
      const updated = planOf(response).clusters.find((c) => c.caregiverId === west.id)!;
      expect(updated.stops.map((s) => s.dependantId)).toEqual(westCluster.dependantIds);
      expect(updated.stops[0]!.dependantId).toBe(original.stops[2]!.dependantId);
      expect(updated.stops[0]!.scheduledStart < updated.stops[1]!.scheduledStart).toBe(true);
    });

    it('moves a dependant someone left out back to unplaced', async () => {
      const { west } = await twoNeighbourhoods();
      const plan = planOf(await create());
      const clusters = plan.clusters.map((c) => ({
        caregiverId: c.caregiverId,
        dependantIds: c.stops.map((s) => s.dependantId),
      }));
      clusters.find((c) => c.caregiverId === west.id)!.dependantIds.pop();

      const response = await request(app)
        .patch(`/visit-plans/${plan.id}`)
        .set('x-test-auth', SUPERVISOR)
        .send({ clusters });

      expect(planOf(response).unplaced).toHaveLength(1);
    });

    it('rejects edits that name a stranger, repeat someone, or touch a published plan', async () => {
      await twoNeighbourhoods();
      const plan = planOf(await create());
      const clusters = plan.clusters.map((c) => ({
        caregiverId: c.caregiverId,
        dependantIds: c.stops.map((s) => s.dependantId),
      }));
      const patch = (next: typeof clusters) =>
        request(app)
          .patch(`/visit-plans/${plan.id}`)
          .set('x-test-auth', SUPERVISOR)
          .send({ clusters: next });

      const stranger = await addDependant('Stranger', HOME, supervisorId);
      expect(
        (
          await patch([
            { ...clusters[0]!, dependantIds: [...clusters[0]!.dependantIds, stranger.id] },
            clusters[1]!,
          ])
        ).status,
      ).toBe(400);
      expect(
        (
          await patch([
            {
              ...clusters[0]!,
              dependantIds: [...clusters[0]!.dependantIds, clusters[1]!.dependantIds[0]!],
            },
            clusters[1]!,
          ])
        ).status,
      ).toBe(400);

      await request(app).post(`/visit-plans/${plan.id}/publish`).set('x-test-auth', SUPERVISOR);
      expect((await patch(clusters)).status).toBe(409);
    });

    it('refuses to publish over a visit booked since the draft', async () => {
      const { west } = await twoNeighbourhoods();
      const plan = planOf(await create());
      const cluster = plan.clusters.find((c) => c.caregiverId === west.id)!;
      const stranger = await addDependant('New', HOME, supervisorId);
      await addVisit(
        west.id,
        stranger.id,
        supervisorId,
        new Date(cluster.stops[0]!.scheduledStart),
        30,
      );

      const response = await request(app)
        .post(`/visit-plans/${plan.id}/publish`)
        .set('x-test-auth', SUPERVISOR);

      expect(response.status).toBe(409);
      expect(await getDb().select().from(schema.visitSchedules)).toHaveLength(1);
      const [stored] = await getDb().select().from(schema.visitPlans);
      expect(stored?.status).toBe('draft');
    });

    it('refuses to publish if consent has been withdrawn since', async () => {
      await twoNeighbourhoods();
      const plan = planOf(await create());
      await getDb().update(schema.consentRecords).set({ revokedAt: NOW });

      const response = await request(app)
        .post(`/visit-plans/${plan.id}/publish`)
        .set('x-test-auth', SUPERVISOR);

      expect(response.status).toBe(422);
    });

    it('rejects bad input, past days and other roles', async () => {
      expect((await create({ shiftStart: '9am' })).status).toBe(400);
      expect((await create({ shiftEnd: '07:00' })).status).toBe(400);
      expect((await create({ visitMinutes: 5 })).status).toBe(400);
      expect((await create({ date: '2026-11-09' })).status).toBe(400);
      await addCaregiver('cg', HOME);
      const asCaregiver = await request(app)
        .post('/visit-plans')
        .set('x-test-auth', auth('cg', 'caregiver'))
        .send(body);
      expect(asCaregiver.status).toBe(403);
    });

    it('returns 404 for an unknown plan', async () => {
      const response = await request(app)
        .get('/visit-plans/00000000-0000-4000-8000-000000000000')
        .set('x-test-auth', SUPERVISOR);
      expect(response.status).toBe(404);
    });
  });

  describe('missed-visit recovery', () => {
    const CG = (sub: string) => auth(sub, 'caregiver');
    const mine = (sub: string) =>
      request(app).get('/recovery-offers/mine').set('x-test-auth', CG(sub));
    const accept = (id: string, sub: string) =>
      request(app).post(`/recovery-offers/${id}/accept`).set('x-test-auth', CG(sub));
    const decline = (id: string, sub: string) =>
      request(app).post(`/recovery-offers/${id}/decline`).set('x-test-auth', CG(sub));

    // A visit 20 minutes late, with three possible covers at increasing distance.
    async function lateVisit() {
      const original = await addCaregiver('original', { lat: -1.3, lng: 36.7 });
      const near = await addCaregiver('near', { lat: HOME.lat, lng: HOME.lng + 0.01 });
      const middle = await addCaregiver('middle', { lat: HOME.lat, lng: HOME.lng + 0.03 });
      const far = await addCaregiver('far', { lat: HOME.lat, lng: HOME.lng + 0.06 });
      const dependant = await addDependant('Wanjiku', HOME, supervisorId);
      const visit = await addVisit(original.id, dependant.id, supervisorId, minutes(-20));
      return { original, near, middle, far, dependant, visit };
    }

    it('leaves a visit alone until its check-in counts as late', async () => {
      const original = await addCaregiver('original', HOME);
      await addCaregiver('near', HOME);
      const dependant = await addDependant('On time', HOME, supervisorId);
      await addVisit(original.id, dependant.id, supervisorId, minutes(-10));

      await runVisitRecovery(getDb(), NOW);

      expect(await cases()).toHaveLength(0);
    });

    it('ignores a visit whose window has already ended', async () => {
      const original = await addCaregiver('original', HOME);
      await addCaregiver('near', HOME);
      const dependant = await addDependant('Over', HOME, supervisorId);
      await addVisit(original.id, dependant.id, supervisorId, minutes(-120));

      await runVisitRecovery(getDb(), NOW);

      expect(await cases()).toHaveLength(0);
    });

    it('offers a late visit to the nearest caregiver, once', async () => {
      const { near } = await lateVisit();

      await runVisitRecovery(getDb(), NOW);
      await runVisitRecovery(getDb(), NOW);

      expect(await cases()).toHaveLength(1);
      const all = await offers();
      expect(all).toHaveLength(1);
      expect(all[0]?.caregiverId).toBe(near.id);
    });

    it('measures from where a caregiver last checked in today, over their home base', async () => {
      const { near, far } = await lateVisit();
      // "far" lives far away but has just finished a visit next door.
      const nextDoor = await addDependant('Next door', HOME, supervisorId);
      const earlier = await addVisit(
        far.id,
        nextDoor.id,
        supervisorId,
        minutes(-100),
        60,
        'completed',
      );
      await getDb()
        .insert(schema.verificationEvents)
        .values({
          visitScheduleId: earlier.id,
          checkinAt: minutes(-100),
          checkoutAt: minutes(-40),
          checkinGpsLat: HOME.lat,
          checkinGpsLng: HOME.lng,
          checkoutGpsLat: HOME.lat,
          checkoutGpsLng: HOME.lng,
        });

      await runVisitRecovery(getDb(), NOW);

      const [offer] = await offers();
      expect(offer?.caregiverId).toBe(far.id);
      expect(offer?.caregiverId).not.toBe(near.id);
    });

    it('skips the original caregiver, anyone inactive, without consent, or busy', async () => {
      const original = await addCaregiver('original', HOME);
      await addCaregiver('inactive', HOME, { active: false });
      await addCaregiver('unconsented', HOME, { consent: false });
      await addCaregiver('no-location', null);
      const busy = await addCaregiver('busy', HOME);
      const other = await addDependant('Other', { lat: -1.2, lng: 36.9 }, supervisorId);
      await addVisit(busy.id, other.id, supervisorId, minutes(-5), 120, 'in_progress');
      const dependant = await addDependant('Wanjiku', HOME, supervisorId);
      await addVisit(original.id, dependant.id, supervisorId, minutes(-20));

      await runVisitRecovery(getDb(), NOW);

      expect(await offers()).toHaveLength(0);
      expect((await cases())[0]?.status).toBe('exhausted');
    });

    it('moves on when an offer expires', async () => {
      const { near, middle } = await lateVisit();
      await runVisitRecovery(getDb(), NOW);

      await runVisitRecovery(getDb(), minutes(6));

      const all = await offers();
      expect(all.find((o) => o.caregiverId === near.id)?.status).toBe('expired');
      expect(all.find((o) => o.caregiverId === middle.id)?.status).toBe('offered');
    });

    it('moves on at once when an offer is declined', async () => {
      const { near, middle } = await lateVisit();
      await runVisitRecovery(getDb(), NOW);
      const [offer] = await offers();

      const response = await decline(offer!.id, 'near');

      expect(response.status).toBe(204);
      const all = await offers();
      expect(all.find((o) => o.caregiverId === near.id)?.status).toBe('declined');
      expect(all.find((o) => o.caregiverId === middle.id)?.status).toBe('offered');
    });

    it(`stops after ${MAX_OFFERS} offers and tells supervisors no cover was found`, async () => {
      await lateVisit();
      await addCaregiver('fourth', { lat: HOME.lat, lng: HOME.lng + 0.09 });
      await runVisitRecovery(getDb(), NOW);
      await runVisitRecovery(getDb(), minutes(6));
      await runVisitRecovery(getDb(), minutes(12));

      await runVisitRecovery(getDb(), minutes(18));

      expect(await offers()).toHaveLength(MAX_OFFERS);
      expect((await cases())[0]?.status).toBe('exhausted');
      const alerts = await getDb().select().from(schema.notificationLog);
      expect(alerts).toMatchObject([{ type: 'no_cover_found', recipientUserId: null }]);
    });

    it('shows the ward and times, but not who or where, until accepted', async () => {
      await lateVisit();
      await runVisitRecovery(getDb(), NOW);

      const response = await mine('near');

      expect(response.status).toBe(200);
      const [item] = (response.body as { items: Record<string, unknown>[] }).items;
      expect(item).toMatchObject({ ward: 'KILELESHWA' });
      expect(JSON.stringify(item)).not.toContain('Wanjiku');
      expect(JSON.stringify(item)).not.toContain('Mugo');
    });

    it('only shows an offer to the caregiver it was made to', async () => {
      await lateVisit();
      await runVisitRecovery(getDb(), NOW);

      expect((await mine('middle')).body).toEqual({ items: [] });
    });

    it('accepting replaces the visit and closes the case', async () => {
      const { near, visit, dependant } = await lateVisit();
      await runVisitRecovery(getDb(), NOW);
      const [offer] = await offers();

      const response = await accept(offer!.id, 'near');

      expect(response.status).toBe(200);
      expect((await visitById(visit.id)).status).toBe('reassigned');
      const replacement = await visitById(
        (response.body as { visitScheduleId: string }).visitScheduleId,
      );
      expect(replacement).toMatchObject({
        caregiverId: near.id,
        dependantId: dependant.id,
        status: 'scheduled',
        recoveredFromVisitId: visit.id,
      });
      expect(replacement.scheduledEnd.getTime() - replacement.scheduledStart.getTime()).toBe(
        3_600_000,
      );
      expect((await cases())[0]).toMatchObject({
        status: 'recovered',
        replacementVisitId: replacement.id,
      });
    });

    it('lets only one of two simultaneous acceptances win', async () => {
      await lateVisit();
      await runVisitRecovery(getDb(), NOW);
      const [offer] = await offers();

      const results = await Promise.all([accept(offer!.id, 'near'), accept(offer!.id, 'near')]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await getDb().select().from(schema.visitSchedules)).toHaveLength(2);
    });

    it('refuses an expired offer', async () => {
      await lateVisit();
      await runVisitRecovery(getDb(), NOW);
      await getDb()
        .update(schema.visitRecoveryOffers)
        .set({ expiresAt: minutes(-1) });
      const [offer] = await offers();

      expect((await accept(offer!.id, 'near')).status).toBe(409);
    });

    it("doesn't let another caregiver take someone else's offer", async () => {
      await lateVisit();
      await runVisitRecovery(getDb(), NOW);
      const [offer] = await offers();

      expect((await accept(offer!.id, 'middle')).status).toBe(404);
      expect((await decline(offer!.id, 'middle')).status).toBe(404);
    });

    it('stands down if the original caregiver checks in late', async () => {
      const { visit } = await lateVisit();
      await runVisitRecovery(getDb(), NOW);
      const [offer] = await offers();
      await getDb()
        .update(schema.visitSchedules)
        .set({ status: 'in_progress' })
        .where(eq(schema.visitSchedules.id, visit.id));

      // Before the next run: the offer has already gone, and can't be accepted.
      expect((await mine('near')).body).toEqual({ items: [] });
      expect((await accept(offer!.id, 'near')).status).toBe(409);
      expect((await visitById(visit.id)).status).toBe('in_progress');

      await runVisitRecovery(getDb(), minutes(1));

      expect((await cases())[0]?.status).toBe('closed');
      expect((await offers())[0]?.status).toBe('withdrawn');
    });

    it('frees the slot, so a replacement in the same window is allowed', async () => {
      const { visit } = await lateVisit();
      await runVisitRecovery(getDb(), NOW);
      const [offer] = await offers();

      const response = await accept(offer!.id, 'near');
      const replacement = await visitById(
        (response.body as { visitScheduleId: string }).visitScheduleId,
      );

      // The two windows overlap for the same dependant, which only 'reassigned' permits.
      expect(replacement.scheduledStart.getTime()).toBeLessThan(visit.scheduledEnd.getTime());
    });

    it('does not offer anything to other roles', async () => {
      const response = await request(app)
        .get('/recovery-offers/mine')
        .set('x-test-auth', SUPERVISOR);
      expect(response.status).toBe(403);
    });
  });
});

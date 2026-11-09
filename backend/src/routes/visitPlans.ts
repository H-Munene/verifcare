// Day planning (2026-11-09): POST /visit-plans drafts a plan, GET shows it, PATCH lets a supervisor
// move or reorder stops, and POST .../publish turns it into real visits.
//
// A plan is only ever a draft until a supervisor publishes it (user decision: the system proposes
// the times, a person signs them off), so generating one has no effect on anybody's schedule.
//
// Anyone who can't be planned is reported with the reason rather than quietly left out.

import { and, eq, gte, inArray, lt, notInArray } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { requireRole } from '../auth/middleware.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import { subjectsWithActiveConsent } from '../db/consents.js';
import { isPostgresExclusionViolation } from '../db/postgresErrors.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { addDays, dayStart, nairobiDate, UTC_OFFSET } from '../nairobiTime.js';
import {
  buildTimetable,
  planDay,
  type GeoPoint,
  type PlanCaregiver,
  type PlanStop,
  type Timetable,
} from '../planning/plan.js';
import { parseOrSendProblem } from '../validation.js';

export interface VisitPlansRouterDependencies {
  requireAuth: RequestHandler;
  now?: () => Date;
}

type UnplacedReason = 'already_scheduled' | 'no_consent' | 'shift_full';

interface UnplacedEntry {
  dependantId: string;
  reason: UnplacedReason;
}

interface ExcludedCaregiver {
  caregiverId: string;
  reason: 'already_scheduled' | 'no_consent' | 'no_home_base';
}

interface StoredStop {
  dependantId: string;
  scheduledStart: string;
  scheduledEnd: string;
  travelMinutes: number;
  distanceMeters: number;
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

const createPlanRequestSchema = z
  .object({
    date: z.iso.date(),
    shiftStart: z.string().regex(TIME_OF_DAY, 'shiftStart must be HH:MM'),
    shiftEnd: z.string().regex(TIME_OF_DAY, 'shiftEnd must be HH:MM'),
    visitMinutes: z.number().int().min(15).max(240),
    dependantIds: z.array(z.string().uuid()).min(1).optional(),
    caregiverIds: z.array(z.string().uuid()).min(1).optional(),
  })
  .refine((body) => body.shiftEnd > body.shiftStart, {
    message: 'shiftEnd must be after shiftStart',
    path: ['shiftEnd'],
  });

const updatePlanRequestSchema = z.object({
  clusters: z
    .array(z.object({ caregiverId: z.string().uuid(), dependantIds: z.array(z.string().uuid()) }))
    .min(1),
});

const planIdParamSchema = z.string().uuid();
const listQuerySchema = z.object({ date: z.iso.date() });

function getDb(res: Response): Db | undefined {
  const db = res.req.app.locals.db as Db | undefined;
  if (!db) {
    sendProblem(res, {
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      detail: 'No database client is configured.',
    });
  }
  return db;
}

function atNairobi(date: string, time: string): Date {
  return new Date(`${date}T${time}:00${UTC_OFFSET}`);
}

function toStoredStops(timetable: Timetable): StoredStop[] {
  return timetable.stops.map((stop) => ({
    dependantId: stop.id,
    scheduledStart: stop.scheduledStart.toISOString(),
    scheduledEnd: stop.scheduledEnd.toISOString(),
    travelMinutes: stop.travelMinutes,
    distanceMeters: Math.round(stop.distanceMeters),
  }));
}

async function loadPlanResponse(db: Db, planId: string) {
  const [plan] = await db.select().from(schema.visitPlans).where(eq(schema.visitPlans.id, planId));
  if (!plan) {
    return undefined;
  }
  const clusters = await db
    .select({
      cluster: schema.visitPlanClusters,
      caregiverName: schema.users.fullName,
      baseLat: schema.caregivers.baseLat,
      baseLng: schema.caregivers.baseLng,
    })
    .from(schema.visitPlanClusters)
    .innerJoin(
      schema.caregivers,
      eq(schema.caregivers.userId, schema.visitPlanClusters.caregiverId),
    )
    .innerJoin(schema.users, eq(schema.users.id, schema.caregivers.userId))
    .where(eq(schema.visitPlanClusters.planId, planId));

  const unplaced = plan.unplaced as UnplacedEntry[];
  const excluded = plan.excludedCaregivers as ExcludedCaregiver[];
  const dependantIds = [
    ...clusters.flatMap(({ cluster }) =>
      (cluster.stops as StoredStop[]).map((stop) => stop.dependantId),
    ),
    ...unplaced.map((entry) => entry.dependantId),
  ];
  const dependants =
    dependantIds.length === 0
      ? []
      : await db
          .select({
            id: schema.dependants.id,
            fullName: schema.dependants.fullName,
            lat: schema.dependants.geofenceLat,
            lng: schema.dependants.geofenceLng,
            ward: schema.dependants.ward,
          })
          .from(schema.dependants)
          .where(inArray(schema.dependants.id, dependantIds));
  const byId = new Map(dependants.map((d) => [d.id, d]));
  const excludedNames =
    excluded.length === 0
      ? []
      : await db
          .select({ id: schema.users.id, fullName: schema.users.fullName })
          .from(schema.users)
          .where(
            inArray(
              schema.users.id,
              excluded.map((e) => e.caregiverId),
            ),
          );
  const nameOf = new Map(excludedNames.map((row) => [row.id, row.fullName]));

  return {
    id: plan.id,
    date: plan.planDate,
    shiftStart: plan.shiftStart,
    shiftEnd: plan.shiftEnd,
    visitMinutes: plan.visitMinutes,
    status: plan.status,
    publishedAt: plan.publishedAt?.toISOString() ?? null,
    clusters: clusters
      .map(({ cluster, caregiverName, baseLat, baseLng }) => ({
        id: cluster.id,
        caregiverId: cluster.caregiverId,
        caregiverName,
        base: { lat: baseLat, lng: baseLng },
        totalDistanceMeters: Math.round(cluster.totalDistanceMeters),
        totalTravelMinutes: cluster.totalTravelMinutes,
        stops: (cluster.stops as StoredStop[]).map((stop) => {
          const dependant = byId.get(stop.dependantId);
          return {
            ...stop,
            dependantName: dependant?.fullName ?? 'Unknown dependant',
            lat: dependant?.lat ?? null,
            lng: dependant?.lng ?? null,
            ward: dependant?.ward ?? null,
          };
        }),
      }))
      .sort((a, b) => a.caregiverName.localeCompare(b.caregiverName)),
    unplaced: unplaced.map((entry) => ({
      ...entry,
      dependantName: byId.get(entry.dependantId)?.fullName ?? 'Unknown dependant',
    })),
    excludedCaregivers: excluded.map((entry) => ({
      ...entry,
      caregiverName: nameOf.get(entry.caregiverId) ?? 'Unknown caregiver',
    })),
  };
}

export function createVisitPlansRouter(dependencies: VisitPlansRouterDependencies): Router {
  const router = Router();
  const { requireAuth } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  router.use(requireAuth, requireRole('supervisor'));

  async function callerId(db: Db, sub: string): Promise<string> {
    const row = await getUserByCognitoSub(db, sub);
    if (!row) {
      throw new Error(`No users row found for authenticated caller sub ${sub}.`);
    }
    return row.id;
  }

  // What already fills a day, so a plan can't be built on top of it.
  async function visitsOn(db: Db, date: string) {
    return db
      .select({
        caregiverId: schema.visitSchedules.caregiverId,
        dependantId: schema.visitSchedules.dependantId,
      })
      .from(schema.visitSchedules)
      .where(
        and(
          gte(schema.visitSchedules.scheduledStart, dayStart(date)),
          lt(schema.visitSchedules.scheduledStart, dayStart(addDays(date, 1))),
          notInArray(schema.visitSchedules.status, ['cancelled', 'reassigned']),
        ),
      );
  }

  router.post('/', async (req, res, next) => {
    const body = parseOrSendProblem(createPlanRequestSchema, req.body, res);
    const db = body && getDb(res);
    if (!body || !db || !req.auth) {
      return;
    }
    if (body.date < nairobiDate(now())) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'A plan can only be made for today or a later day.',
      });
      return;
    }

    try {
      const createdBy = await callerId(db, req.auth.sub);
      const [dependants, caregivers, existing] = await Promise.all([
        db
          .select({
            id: schema.dependants.id,
            lat: schema.dependants.geofenceLat,
            lng: schema.dependants.geofenceLng,
          })
          .from(schema.dependants)
          .where(
            and(
              eq(schema.dependants.status, 'active'),
              body.dependantIds ? inArray(schema.dependants.id, body.dependantIds) : undefined,
            ),
          ),
        db
          .select({
            id: schema.caregivers.userId,
            baseLat: schema.caregivers.baseLat,
            baseLng: schema.caregivers.baseLng,
          })
          .from(schema.caregivers)
          .innerJoin(schema.users, eq(schema.users.id, schema.caregivers.userId))
          .where(
            and(
              eq(schema.caregivers.active, true),
              eq(schema.users.status, 'active'),
              body.caregiverIds ? inArray(schema.caregivers.userId, body.caregiverIds) : undefined,
            ),
          ),
        visitsOn(db, body.date),
      ]);

      const [dependantConsent, caregiverConsent] = await Promise.all([
        subjectsWithActiveConsent(
          db,
          dependants.map((d) => ({ subjectType: 'dependant' as const, id: d.id })),
          'location_verification',
        ),
        subjectsWithActiveConsent(
          db,
          caregivers.map((c) => ({ subjectType: 'caregiver' as const, id: c.id })),
          'location_verification',
        ),
      ]);

      const scheduledDependants = new Set(existing.map((v) => v.dependantId));
      const busyCaregivers = new Set(existing.map((v) => v.caregiverId));
      const unplaced: UnplacedEntry[] = [];
      const stops: PlanStop[] = [];
      for (const dependant of dependants) {
        if (scheduledDependants.has(dependant.id)) {
          unplaced.push({ dependantId: dependant.id, reason: 'already_scheduled' });
        } else if (!dependantConsent.has(dependant.id)) {
          unplaced.push({ dependantId: dependant.id, reason: 'no_consent' });
        } else {
          stops.push(dependant);
        }
      }
      const excluded: ExcludedCaregiver[] = [];
      const available: PlanCaregiver[] = [];
      for (const caregiver of caregivers) {
        if (caregiver.baseLat === null || caregiver.baseLng === null) {
          excluded.push({ caregiverId: caregiver.id, reason: 'no_home_base' });
        } else if (busyCaregivers.has(caregiver.id)) {
          excluded.push({ caregiverId: caregiver.id, reason: 'already_scheduled' });
        } else if (!caregiverConsent.has(caregiver.id)) {
          excluded.push({ caregiverId: caregiver.id, reason: 'no_consent' });
        } else {
          available.push({
            id: caregiver.id,
            base: { lat: caregiver.baseLat, lng: caregiver.baseLng },
          });
        }
      }

      const plan = planDay({
        stops,
        caregivers: available,
        shiftStart: atNairobi(body.date, body.shiftStart),
        shiftEnd: atNairobi(body.date, body.shiftEnd),
        visitMinutes: body.visitMinutes,
      });
      for (const stop of plan.unplaced) {
        unplaced.push({ dependantId: stop.id, reason: 'shift_full' });
      }

      const planId = uuidv7();
      await db.transaction(async (tx) => {
        await tx.insert(schema.visitPlans).values({
          id: planId,
          planDate: body.date,
          shiftStart: body.shiftStart,
          shiftEnd: body.shiftEnd,
          visitMinutes: body.visitMinutes,
          unplaced,
          excludedCaregivers: excluded,
          createdBy,
        });
        if (plan.routes.length > 0) {
          await tx.insert(schema.visitPlanClusters).values(
            plan.routes.map((route) => ({
              planId,
              caregiverId: route.caregiverId,
              stops: toStoredStops(route),
              totalDistanceMeters: route.totalDistanceMeters,
              totalTravelMinutes: route.totalTravelMinutes,
            })),
          );
        }
        await recordAudit(tx, {
          actorUserId: createdBy,
          action: 'visit_plan.create',
          entityType: 'visit_plan',
          entityId: planId,
          metadata: { date: body.date, routes: plan.routes.length, unplaced: unplaced.length },
        });
      });
      res.status(201).json(await loadPlanResponse(db, planId));
    } catch (err) {
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    const query = parseOrSendProblem(listQuerySchema, req.query, res);
    const db = query && getDb(res);
    if (!query || !db) {
      return;
    }
    try {
      const plans = await db
        .select({ id: schema.visitPlans.id })
        .from(schema.visitPlans)
        .where(eq(schema.visitPlans.planDate, query.date));
      const items = await Promise.all(plans.map((plan) => loadPlanResponse(db, plan.id)));
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:planId', async (req, res, next) => {
    const planId = parseOrSendProblem(planIdParamSchema, req.params.planId, res);
    const db = planId && getDb(res);
    if (!planId || !db) {
      return;
    }
    try {
      const plan = await loadPlanResponse(db, planId);
      if (!plan) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      res.status(200).json(plan);
    } catch (err) {
      next(err);
    }
  });

  // Sends the whole arrangement: each caregiver's stops in order. Times are worked out again from
  // that order, and anyone left out or no longer fitting is reported as unplaced.
  router.patch('/:planId', async (req, res, next) => {
    const planId = parseOrSendProblem(planIdParamSchema, req.params.planId, res);
    if (!planId) {
      return;
    }
    const body = parseOrSendProblem(updatePlanRequestSchema, req.body, res);
    const db = body && getDb(res);
    if (!body || !db || !req.auth) {
      return;
    }
    const bad = (detail: string) =>
      sendProblem(res, { type: 'about:blank', title: 'Bad Request', status: 400, detail });

    try {
      const editor = await callerId(db, req.auth.sub);
      const [plan] = await db
        .select()
        .from(schema.visitPlans)
        .where(eq(schema.visitPlans.id, planId));
      if (!plan) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      if (plan.status !== 'draft') {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'A published plan can no longer be changed.',
        });
        return;
      }
      const clusters = await db
        .select()
        .from(schema.visitPlanClusters)
        .where(eq(schema.visitPlanClusters.planId, planId));

      const previousUnplaced = plan.unplaced as UnplacedEntry[];
      const movable = new Set([
        ...clusters.flatMap((c) => (c.stops as StoredStop[]).map((s) => s.dependantId)),
        ...previousUnplaced.filter((u) => u.reason === 'shift_full').map((u) => u.dependantId),
      ]);
      const planCaregivers = new Set(clusters.map((c) => c.caregiverId));
      const requested = body.clusters.flatMap((c) => c.dependantIds);
      if (new Set(requested).size !== requested.length) {
        bad('A dependant can only appear once in a plan.');
        return;
      }
      if (requested.some((id) => !movable.has(id))) {
        bad('The plan can only include dependants it was made for.');
        return;
      }
      if (
        body.clusters.some((c) => !planCaregivers.has(c.caregiverId)) ||
        new Set(body.clusters.map((c) => c.caregiverId)).size !== body.clusters.length
      ) {
        bad('Each caregiver in the plan can only appear once.');
        return;
      }

      const [homes, bases] = await Promise.all([
        requested.length === 0
          ? []
          : db
              .select({
                id: schema.dependants.id,
                lat: schema.dependants.geofenceLat,
                lng: schema.dependants.geofenceLng,
              })
              .from(schema.dependants)
              .where(inArray(schema.dependants.id, requested)),
        db
          .select({
            id: schema.caregivers.userId,
            lat: schema.caregivers.baseLat,
            lng: schema.caregivers.baseLng,
          })
          .from(schema.caregivers)
          .where(inArray(schema.caregivers.userId, [...planCaregivers])),
      ]);
      const homeOf = new Map(homes.map((h) => [h.id, h]));
      const baseOf = new Map(bases.map((b) => [b.id, b as GeoPoint]));

      const timetables = body.clusters.map((cluster) => ({
        caregiverId: cluster.caregiverId,
        timetable: buildTimetable({
          base: baseOf.get(cluster.caregiverId)!,
          stops: cluster.dependantIds.map((id) => homeOf.get(id)!),
          shiftStart: atNairobi(plan.planDate, plan.shiftStart),
          shiftEnd: atNairobi(plan.planDate, plan.shiftEnd),
          visitMinutes: plan.visitMinutes,
        }),
      }));
      const placed = new Set(timetables.flatMap((t) => t.timetable.stops.map((s) => s.id)));
      const unplaced: UnplacedEntry[] = [
        ...previousUnplaced.filter((u) => u.reason !== 'shift_full'),
        ...[...movable]
          .filter((id) => !placed.has(id))
          .map((dependantId) => ({ dependantId, reason: 'shift_full' as const })),
      ];

      await db.transaction(async (tx) => {
        for (const { caregiverId, timetable } of timetables) {
          await tx
            .update(schema.visitPlanClusters)
            .set({
              stops: toStoredStops(timetable),
              totalDistanceMeters: timetable.totalDistanceMeters,
              totalTravelMinutes: timetable.totalTravelMinutes,
            })
            .where(
              and(
                eq(schema.visitPlanClusters.planId, planId),
                eq(schema.visitPlanClusters.caregiverId, caregiverId),
              ),
            );
        }
        await tx
          .update(schema.visitPlans)
          .set({ unplaced })
          .where(eq(schema.visitPlans.id, planId));
        await recordAudit(tx, {
          actorUserId: editor,
          action: 'visit_plan.update',
          entityType: 'visit_plan',
          entityId: planId,
        });
      });
      res.status(200).json(await loadPlanResponse(db, planId));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:planId/publish', async (req, res, next) => {
    const planId = parseOrSendProblem(planIdParamSchema, req.params.planId, res);
    const db = planId && getDb(res);
    if (!planId || !db || !req.auth) {
      return;
    }
    try {
      const publisher = await callerId(db, req.auth.sub);
      const clusters = await db
        .select()
        .from(schema.visitPlanClusters)
        .where(eq(schema.visitPlanClusters.planId, planId));
      const stops = clusters.flatMap((c) => c.stops as StoredStop[]);

      // Consent may have been withdrawn since the draft was made.
      const [dependantConsent, caregiverConsent] = await Promise.all([
        subjectsWithActiveConsent(
          db,
          stops.map((s) => ({ subjectType: 'dependant' as const, id: s.dependantId })),
          'location_verification',
        ),
        subjectsWithActiveConsent(
          db,
          clusters.map((c) => ({ subjectType: 'caregiver' as const, id: c.caregiverId })),
          'location_verification',
        ),
      ]);
      if (
        stops.some((s) => !dependantConsent.has(s.dependantId)) ||
        clusters.some((c) => !caregiverConsent.has(c.caregiverId))
      ) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'Someone in this plan has withdrawn consent to location checks. Make a new plan.',
        });
        return;
      }

      const at = now();
      const published = await db.transaction(async (tx) => {
        // Status in the WHERE, so publishing twice can't create the visits twice.
        const [plan] = await tx
          .update(schema.visitPlans)
          .set({ status: 'published', publishedAt: at })
          .where(and(eq(schema.visitPlans.id, planId), eq(schema.visitPlans.status, 'draft')))
          .returning();
        if (!plan) {
          return false;
        }
        for (const cluster of clusters) {
          const clusterStops = cluster.stops as StoredStop[];
          if (clusterStops.length === 0) {
            continue;
          }
          await tx.insert(schema.visitSchedules).values(
            clusterStops.map((stop, i) => ({
              id: uuidv7(),
              caregiverId: cluster.caregiverId,
              dependantId: stop.dependantId,
              scheduledStart: new Date(stop.scheduledStart),
              scheduledEnd: new Date(stop.scheduledEnd),
              createdBy: publisher,
              planClusterId: cluster.id,
              routeSequence: i + 1,
            })),
          );
        }
        await recordAudit(tx, {
          actorUserId: publisher,
          action: 'visit_plan.publish',
          entityType: 'visit_plan',
          entityId: planId,
          metadata: { visits: stops.length },
        });
        return true;
      });
      if (!published) {
        const [existing] = await db
          .select({ id: schema.visitPlans.id })
          .from(schema.visitPlans)
          .where(eq(schema.visitPlans.id, planId));
        sendProblem(res, {
          type: 'about:blank',
          title: existing ? 'Conflict' : 'Not Found',
          status: existing ? 409 : 404,
          ...(existing ? { detail: 'This plan has already been published.' } : {}),
        });
        return;
      }
      res.status(200).json(await loadPlanResponse(db, planId));
    } catch (err) {
      if (isPostgresExclusionViolation(err)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail:
            'A visit has been booked since this plan was made and now overlaps it. Make a new plan.',
        });
        return;
      }
      next(err);
    }
  });

  return router;
}

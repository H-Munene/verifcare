// POST/GET /visit-schedules, GET/PATCH /visit-schedules/{visitScheduleId} (HEZ-32).
//
// Ownership/RBAC rules (confirmed with the user before implementing, not assumed, the same way
// HEZ-30/HEZ-31/HEZ-85 resolved their own unstated gaps):
// - POST / and PATCH /{id} (create, reschedule, cancel) are supervisor-only - architecture.md's
//   own permission list names "scheduling" as one of supervisor/administrator's full-permission
//   capabilities, with no equivalent grant for caregiver or family_member.
// - GET / (list) and GET /{id} are open to all three roles, each scoped to what that caller may
//   see: a supervisor sees every visit; a caregiver sees only visits where they're the assigned
//   caregiver; a family_member sees only visits for a dependant they're linked to (the same
//   dependant_family_members ownership check routes/dependants.ts's findFamilyMemberLink already
//   establishes, reused here rather than re-derived).
// - POST /{id}/checkout (HEZ-39) is caregiver-only, own visit, no supervisor override - confirmed
//   with the user rather than assumed, since checkout is a plain status flip (not an identity
//   check like the rest of the check-in flow) and a supervisor override was at least plausible.
//   Kept consistent with the rest of the check-in flow (HEZ-33/34/35: same caregiver-only-own-
//   visit rule) rather than introducing a new authorization branch this flow doesn't otherwise
//   need. Lives here, not routes/checkin.ts, matching openapi.yaml's own tag scoping - the
//   "Check-in" tag is explicitly limited to "the geofence, caregiver-liveness, and
//   dependant-liveness steps," and checkout is tagged "Visit Schedules" instead.
// - GET /{id}/verification (HEZ-42) uses the exact same ownership rule as GET /{id} - confirmed
//   with the user rather than assumed, since its own openapi.yaml description ("the admin web
//   app's visit-history view") could plausibly have meant supervisor-only. A caregiver/family
//   member can see their own visit's verification_events/verification_attempts audit trail, not
//   just supervisors. HEZ-42's other half ("live-visits" - REST polling for in_progress status
//   flags) needed no new endpoint - GET / already supports `?status=in_progress` under the same
//   ownership rule, confirmed with the user as sufficient rather than building a second one.
//
// Double-booking (HEZ-9's excl_visit_schedules_caregiver_overlap/excl_visit_schedules_dependant_
// overlap EXCLUDE USING gist constraints) is surfaced as a clean 409, not a raw DB error, on both
// POST and PATCH - this is HEZ-32's own stated purpose, not an incidental nicety. The two
// constraints are told apart by name (db/postgresErrors.ts's getPostgresConstraintName) so the
// response says which side (caregiver or dependant) is double-booked.
//
// caregiverId/dependantId existence is checked explicitly with a SELECT before insert, the same
// "send the response, return a falsy sentinel" style routes/biometricEnrollments.ts's
// authorizeSubject already uses - a clean 400 naming which field is wrong, rather than letting a
// foreign-key violation surface as an unclassified 500.
//
// PATCH's scheduledStart/scheduledEnd are independently optional (either, both, or neither may be
// present), but the schema's own chk_visit_schedules_end_after_start CHECK constrains the pair
// together - validated here against the merged (existing + patch) row before writing, for the same
// "classify it, don't let it fall through as a raw error" reason the EXCLUDE constraint is.

import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import { getPostgresConstraintName, isPostgresExclusionViolation } from '../db/postgresErrors.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { cursorCondition, decodeCursor, paginate } from '../pagination.js';
import { parseOrSendProblem } from '../validation.js';
import { findFamilyMemberLink } from './dependants.js';

interface VerificationEventResponse {
  visitScheduleId: string;
  checkinAt: string | null;
  checkoutAt: string | null;
  checkinGpsLat: number | null;
  checkinGpsLng: number | null;
  distanceFromGeofenceMeters: number | null;
  caregiverMatchConfidence: number | null;
  dependantMatchConfidence: number | null;
  caregiverLivenessPassed: boolean | null;
  dependantLivenessPassed: boolean | null;
}

function toVerificationEventResponse(
  row: typeof schema.verificationEvents.$inferSelect,
): VerificationEventResponse {
  return {
    visitScheduleId: row.visitScheduleId,
    checkinAt: row.checkinAt ? row.checkinAt.toISOString() : null,
    checkoutAt: row.checkoutAt ? row.checkoutAt.toISOString() : null,
    checkinGpsLat: row.checkinGpsLat,
    checkinGpsLng: row.checkinGpsLng,
    distanceFromGeofenceMeters: row.distanceFromGeofenceMeters,
    caregiverMatchConfidence:
      row.caregiverMatchConfidence === null ? null : Number(row.caregiverMatchConfidence),
    dependantMatchConfidence:
      row.dependantMatchConfidence === null ? null : Number(row.dependantMatchConfidence),
    caregiverLivenessPassed: row.caregiverLivenessPassed,
    dependantLivenessPassed: row.dependantLivenessPassed,
  };
}

interface VerificationAttemptResponse {
  id: string;
  visitScheduleId: string;
  attemptType: 'geofence' | 'caregiver_liveness' | 'dependant_liveness';
  passed: boolean;
  failureReason: string | null;
  attemptedAt: string;
}

function toVerificationAttemptResponse(
  row: typeof schema.verificationAttempts.$inferSelect,
): VerificationAttemptResponse {
  return {
    id: row.id,
    visitScheduleId: row.visitScheduleId,
    attemptType: row.attemptType,
    passed: row.passed,
    failureReason: row.failureReason,
    attemptedAt: row.attemptedAt.toISOString(),
  };
}

export interface VisitSchedulesRouterDependencies {
  requireAuth: RequestHandler;
}

type VisitStatus =
  'scheduled' | 'in_progress' | 'completed' | 'missed' | 'cancelled' | 'investigated';

interface VisitScheduleResponse {
  id: string;
  caregiverId: string;
  dependantId: string;
  // Added alongside HEZ-66 (the caregiver mobile app's schedule calendar and check-in map): every
  // consumer of this endpoint so far (the admin web app's Scheduling page, the caregiver app's
  // calendar) needed a display name per visit and had no other way to get one - a caregiver in
  // particular has no access to GET /dependants at all (routes/dependants.ts is
  // requireRole('supervisor', 'family_member')-only), so this couldn't be worked around
  // client-side the way the web app's Scheduling page currently does (a separate full
  // caregivers/dependants fetch, supervisor-only). Fixed once, here, for every caller, rather than
  // adding another narrow per-role endpoint.
  caregiverDisplayName: string;
  dependantDisplayName: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: VisitStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function toResponse(
  row: typeof schema.visitSchedules.$inferSelect,
  caregiverDisplayName: string,
  dependantDisplayName: string,
): VisitScheduleResponse {
  return {
    id: row.id,
    caregiverId: row.caregiverId,
    dependantId: row.dependantId,
    caregiverDisplayName,
    dependantDisplayName,
    scheduledStart: row.scheduledStart.toISOString(),
    scheduledEnd: row.scheduledEnd.toISOString(),
    status: row.status as VisitStatus,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Batches the caregiver/dependant name lookup across every row at once (not one query pair per
// row) - used by every response site (POST, GET list, GET :id, PATCH) so
// VisitScheduleResponse's two display-name fields are always populated the same way, from one
// place, rather than four slightly different inline joins.
async function attachDisplayNames(
  db: Db,
  rows: (typeof schema.visitSchedules.$inferSelect)[],
): Promise<VisitScheduleResponse[]> {
  if (rows.length === 0) {
    return [];
  }
  const caregiverIds = [...new Set(rows.map((row) => row.caregiverId))];
  const dependantIds = [...new Set(rows.map((row) => row.dependantId))];
  const [caregiverRows, dependantRows] = await Promise.all([
    db
      .select({ id: schema.users.id, fullName: schema.users.fullName })
      .from(schema.users)
      .where(inArray(schema.users.id, caregiverIds)),
    db
      .select({ id: schema.dependants.id, fullName: schema.dependants.fullName })
      .from(schema.dependants)
      .where(inArray(schema.dependants.id, dependantIds)),
  ]);
  const caregiverNames = new Map(caregiverRows.map((row) => [row.id, row.fullName]));
  const dependantNames = new Map(dependantRows.map((row) => [row.id, row.fullName]));
  return rows.map((row) =>
    toResponse(
      row,
      caregiverNames.get(row.caregiverId) ?? 'Unknown caregiver',
      dependantNames.get(row.dependantId) ?? 'Unknown dependant',
    ),
  );
}

const visitStatusSchema = z.enum([
  'scheduled',
  'in_progress',
  'completed',
  'missed',
  'cancelled',
  'investigated',
]);

const createVisitScheduleRequestSchema = z
  .object({
    caregiverId: z.string().uuid(),
    dependantId: z.string().uuid(),
    scheduledStart: z.string().datetime({ offset: true }),
    scheduledEnd: z.string().datetime({ offset: true }),
  })
  .refine((data) => new Date(data.scheduledEnd) > new Date(data.scheduledStart), {
    message: 'scheduledEnd must be after scheduledStart',
    path: ['scheduledEnd'],
  });

const updateVisitScheduleRequestSchema = z.object({
  scheduledStart: z.string().datetime({ offset: true }).optional(),
  scheduledEnd: z.string().datetime({ offset: true }).optional(),
  status: visitStatusSchema.optional(),
});

const listVisitSchedulesQuerySchema = z.object({
  status: visitStatusSchema.optional(),
  caregiverId: z.string().uuid().optional(),
  dependantId: z.string().uuid().optional(),
  scheduledStartFrom: z.string().datetime({ offset: true }).optional(),
  scheduledStartTo: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Express 5's params type allows string | string[], so req.params.visitScheduleId isn't a plain
// string on its own - validated the same way any other input is, via parseOrSendProblem.
const visitScheduleIdParamSchema = z.string().uuid();

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

// Maps an EXCLUDE-constraint violation to a specific, readable detail message rather than a
// generic "conflict" - the two constraints (db/schema.ts's excl_visit_schedules_*_overlap) are
// told apart by name, exactly the way enforcement.integration.test.ts already asserts on them.
function exclusionDetail(err: unknown): string {
  const constraint = getPostgresConstraintName(err);
  if (constraint === 'excl_visit_schedules_caregiver_overlap') {
    return 'This caregiver already has an overlapping, non-cancelled visit scheduled.';
  }
  if (constraint === 'excl_visit_schedules_dependant_overlap') {
    return 'This dependant already has an overlapping, non-cancelled visit scheduled.';
  }
  return 'This visit would double-book the caregiver or dependant into an overlapping window.';
}

export function createVisitSchedulesRouter(dependencies: VisitSchedulesRouterDependencies): Router {
  const router = Router();
  const { requireAuth } = dependencies;
  router.use(requireAuth);

  router.post('/', async (req, res, next) => {
    const body = parseOrSendProblem(createVisitScheduleRequestSchema, req.body, res);
    if (!body) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }
    const caller = req.auth;
    if (!caller) {
      sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
      return;
    }
    if (caller.role !== 'supervisor') {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Only a supervisor may schedule a visit.',
      });
      return;
    }

    try {
      const [caregiver] = await db
        .select({ userId: schema.caregivers.userId })
        .from(schema.caregivers)
        .where(eq(schema.caregivers.userId, body.caregiverId));
      if (!caregiver) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'caregiverId does not reference an existing caregiver.',
        });
        return;
      }
      const [dependant] = await db
        .select({ id: schema.dependants.id })
        .from(schema.dependants)
        .where(eq(schema.dependants.id, body.dependantId));
      if (!dependant) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'dependantId does not reference an existing dependant.',
        });
        return;
      }

      const callerRow = await getUserByCognitoSub(db, caller.sub);
      if (!callerRow) {
        throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
      }

      const [row] = await db
        .insert(schema.visitSchedules)
        .values({
          id: uuidv7(),
          caregiverId: body.caregiverId,
          dependantId: body.dependantId,
          scheduledStart: new Date(body.scheduledStart),
          scheduledEnd: new Date(body.scheduledEnd),
          createdBy: callerRow.id,
        })
        .returning();
      if (!row) {
        throw new Error('Insert into visit_schedules returned no row.');
      }
      const [response] = await attachDisplayNames(db, [row]);
      res.status(201).json(response);
    } catch (err) {
      if (isPostgresExclusionViolation(err)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: exclusionDetail(err),
        });
        return;
      }
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    const query = parseOrSendProblem(listVisitSchedulesQuerySchema, req.query, res);
    if (!query) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }
    const caller = req.auth;
    if (!caller) {
      sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
      return;
    }

    try {
      const conditions = [];
      if (query.status) {
        conditions.push(eq(schema.visitSchedules.status, query.status));
      }
      if (query.caregiverId) {
        conditions.push(eq(schema.visitSchedules.caregiverId, query.caregiverId));
      }
      if (query.dependantId) {
        conditions.push(eq(schema.visitSchedules.dependantId, query.dependantId));
      }
      if (query.scheduledStartFrom) {
        conditions.push(
          gte(schema.visitSchedules.scheduledStart, new Date(query.scheduledStartFrom)),
        );
      }
      if (query.scheduledStartTo) {
        conditions.push(
          lte(schema.visitSchedules.scheduledStart, new Date(query.scheduledStartTo)),
        );
      }
      if (query.cursor) {
        let cursor;
        try {
          cursor = decodeCursor(query.cursor);
        } catch {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: 'Malformed cursor.',
          });
          return;
        }
        conditions.push(cursorCondition(schema.visitSchedules.id, cursor));
      }

      let rows: (typeof schema.visitSchedules.$inferSelect)[];
      if (caller.role === 'supervisor') {
        rows = await db
          .select()
          .from(schema.visitSchedules)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(asc(schema.visitSchedules.id))
          .limit(query.limit + 1);
      } else if (caller.role === 'caregiver') {
        const callerRow = await getUserByCognitoSub(db, caller.sub);
        if (!callerRow) {
          throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
        }
        conditions.push(eq(schema.visitSchedules.caregiverId, callerRow.id));
        rows = await db
          .select()
          .from(schema.visitSchedules)
          .where(and(...conditions))
          .orderBy(asc(schema.visitSchedules.id))
          .limit(query.limit + 1);
      } else {
        const callerRow = await getUserByCognitoSub(db, caller.sub);
        if (!callerRow) {
          throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
        }
        conditions.push(eq(schema.dependantFamilyMembers.familyMemberUserId, callerRow.id));
        const joined = await db
          .select({ visitSchedule: schema.visitSchedules })
          .from(schema.visitSchedules)
          .innerJoin(
            schema.dependantFamilyMembers,
            eq(schema.visitSchedules.dependantId, schema.dependantFamilyMembers.dependantId),
          )
          .where(and(...conditions))
          .orderBy(asc(schema.visitSchedules.id))
          .limit(query.limit + 1);
        rows = joined.map((r) => r.visitSchedule);
      }

      const { items, nextCursor } = paginate(rows, query.limit, (row) => ({ id: row.id }));
      res.status(200).json({ items: await attachDisplayNames(db, items), nextCursor });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:visitScheduleId', async (req, res, next) => {
    const visitScheduleId = parseOrSendProblem(
      visitScheduleIdParamSchema,
      req.params.visitScheduleId,
      res,
    );
    if (!visitScheduleId) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }
    const caller = req.auth;
    if (!caller) {
      sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
      return;
    }

    try {
      const [row] = await db
        .select()
        .from(schema.visitSchedules)
        .where(eq(schema.visitSchedules.id, visitScheduleId));
      if (!row) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }

      if (caller.role === 'caregiver') {
        const callerRow = await getUserByCognitoSub(db, caller.sub);
        if (!callerRow || row.caregiverId !== callerRow.id) {
          sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
          return;
        }
      } else if (caller.role === 'family_member') {
        const found = await findFamilyMemberLink(db, row.dependantId, caller.sub);
        if (!found) {
          sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
          return;
        }
      }

      const [response] = await attachDisplayNames(db, [row]);
      res.status(200).json(response);
    } catch (err) {
      next(err);
    }
  });

  // GET /{id}/verification (HEZ-42): the verification_events + verification_attempts audit trail
  // for a visit, under the exact same ownership rule as GET /{id} above (confirmed with the user,
  // not assumed - see the file header comment). `event` is null when the visit has never reached
  // even the geofence step (no verification_events row exists yet) - a real gap in openapi.yaml's
  // own draft schema (VerificationAudit.event wasn't marked nullable), fixed alongside this route.
  router.get('/:visitScheduleId/verification', async (req, res, next) => {
    const visitScheduleId = parseOrSendProblem(
      visitScheduleIdParamSchema,
      req.params.visitScheduleId,
      res,
    );
    if (!visitScheduleId) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }
    const caller = req.auth;
    if (!caller) {
      sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
      return;
    }

    try {
      const [visit] = await db
        .select()
        .from(schema.visitSchedules)
        .where(eq(schema.visitSchedules.id, visitScheduleId));
      if (!visit) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }

      if (caller.role === 'caregiver') {
        const callerRow = await getUserByCognitoSub(db, caller.sub);
        if (!callerRow || visit.caregiverId !== callerRow.id) {
          sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
          return;
        }
      } else if (caller.role === 'family_member') {
        const found = await findFamilyMemberLink(db, visit.dependantId, caller.sub);
        if (!found) {
          sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
          return;
        }
      }

      const [event] = await db
        .select()
        .from(schema.verificationEvents)
        .where(eq(schema.verificationEvents.visitScheduleId, visitScheduleId));
      const attempts = await db
        .select()
        .from(schema.verificationAttempts)
        .where(eq(schema.verificationAttempts.visitScheduleId, visitScheduleId))
        .orderBy(asc(schema.verificationAttempts.attemptedAt));

      res.status(200).json({
        event: event ? toVerificationEventResponse(event) : null,
        attempts: attempts.map(toVerificationAttemptResponse),
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:visitScheduleId', async (req, res, next) => {
    const visitScheduleId = parseOrSendProblem(
      visitScheduleIdParamSchema,
      req.params.visitScheduleId,
      res,
    );
    if (!visitScheduleId) {
      return;
    }
    const body = parseOrSendProblem(updateVisitScheduleRequestSchema, req.body, res);
    if (!body) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }
    const caller = req.auth;
    if (!caller) {
      sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
      return;
    }
    if (caller.role !== 'supervisor') {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Only a supervisor may reschedule or cancel a visit.',
      });
      return;
    }

    try {
      const [existing] = await db
        .select()
        .from(schema.visitSchedules)
        .where(eq(schema.visitSchedules.id, visitScheduleId));
      if (!existing) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }

      const mergedStart = body.scheduledStart
        ? new Date(body.scheduledStart)
        : existing.scheduledStart;
      const mergedEnd = body.scheduledEnd ? new Date(body.scheduledEnd) : existing.scheduledEnd;
      if (mergedEnd <= mergedStart) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: 'scheduledEnd must be after scheduledStart.',
        });
        return;
      }

      const [updated] = await db
        .update(schema.visitSchedules)
        .set({
          ...(body.scheduledStart !== undefined && { scheduledStart: mergedStart }),
          ...(body.scheduledEnd !== undefined && { scheduledEnd: mergedEnd }),
          ...(body.status !== undefined && { status: body.status }),
          updatedAt: new Date(),
        })
        .where(eq(schema.visitSchedules.id, visitScheduleId))
        .returning();
      if (!updated) {
        throw new Error('Update to visit_schedules returned no row.');
      }
      const [response] = await attachDisplayNames(db, [updated]);
      res.status(200).json(response);
    } catch (err) {
      if (isPostgresExclusionViolation(err)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: exclusionDetail(err),
        });
        return;
      }
      next(err);
    }
  });

  // POST /{id}/checkout (HEZ-39): the final step of the check-in flow (architecture.md step 5) -
  // sets verification_events.checkout_at and flips visit_schedules.status to 'completed'.
  // Deliberately does not depend on HEZ-38 (audio upload + acoustic-model call), which is
  // separately deferred (milestone 4) - nothing here checks for an audio_records row.
  router.post('/:visitScheduleId/checkout', async (req, res, next) => {
    const visitScheduleId = parseOrSendProblem(
      visitScheduleIdParamSchema,
      req.params.visitScheduleId,
      res,
    );
    if (!visitScheduleId) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }
    const caller = req.auth;
    if (!caller) {
      sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
      return;
    }
    if (caller.role !== 'caregiver') {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Only the assigned caregiver may check out of a visit.',
      });
      return;
    }

    try {
      const callerRow = await getUserByCognitoSub(db, caller.sub);
      if (!callerRow) {
        throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
      }

      const [visit] = await db
        .select()
        .from(schema.visitSchedules)
        .where(eq(schema.visitSchedules.id, visitScheduleId));
      if (!visit) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      if (visit.caregiverId !== callerRow.id) {
        sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
        return;
      }
      if (visit.status !== 'in_progress') {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: `This visit hasn't been checked in yet, or is already completed/cancelled (current status: ${visit.status}).`,
        });
        return;
      }

      const now = new Date();
      const [updated] = await db.transaction(async (tx) => {
        await tx
          .update(schema.verificationEvents)
          .set({ checkoutAt: now })
          .where(eq(schema.verificationEvents.visitScheduleId, visitScheduleId));
        return tx
          .update(schema.visitSchedules)
          .set({ status: 'completed', updatedAt: now })
          .where(eq(schema.visitSchedules.id, visitScheduleId))
          .returning();
      });
      if (!updated) {
        throw new Error('Update to visit_schedules returned no row.');
      }
      const [response] = await attachDisplayNames(db, [updated]);
      res.status(200).json(response);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

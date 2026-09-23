// GET/PUT /visit-schedules/{visitScheduleId}/tasks[/{careTaskId}] (docs/visit-task-checklist-plan.md).
// Mounted at the same /visit-schedules prefix as visitSchedules.ts and checkin.ts, kept as its own
// router/file since this is a materially different concern from both (not schedule CRUD, not
// geofence/liveness verification) - matches checkin.ts's own precedent for splitting concerns
// under a shared path prefix rather than growing either existing (already 700+ line) file further.
//
// RBAC: caregiver-only, own visit, status === 'in_progress' - the checklist is worked through
// during the visit, after check-in and before checkout, matching real-world home-care practice
// (see the plan doc's section 1). No check-in session-token requirement here (unlike checkin.ts's
// post-geofence routes) - by the time a visit is in_progress, the full check-in flow has already
// passed, and the session token's job (proving the geofence step was recently passed) is done.
//
// Live-joined, no snapshot: GET returns dependant_care_tasks (active, for this visit's dependant)
// LEFT JOINed against whatever visit_task_completions rows already exist for this visit - see the
// plan doc's section 2 for why no per-visit snapshot step exists. A supervisor mid-visit care-plan
// edit is naturally reflected on the caregiver's next GET, rather than silently ignored.
//
// "Locked after checkout": PUT rejects (409) once the visit is no longer in_progress - enforced
// here in application code, not a DB trigger (see schema.ts's own comment on
// visit_task_completions for why this table has no forbid_update_delete trigger the way
// verification_attempts/audit_log do).

import { and, asc, eq } from 'drizzle-orm';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth/middleware.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { parseOrSendProblem } from '../validation.js';

export interface VisitTasksRouterDependencies {
  requireAuth: RequestHandler;
}

interface VisitTaskResponse {
  careTaskId: string;
  title: string;
  description: string | null;
  category: string | null;
  required: boolean;
  status: 'completed' | 'not_completed' | 'not_applicable' | null;
  reason: string | null;
  notes: string | null;
  completedAt: string | null;
}

const visitScheduleIdParamSchema = z.string().uuid();
const careTaskIdParamSchema = z.string().uuid();

// Mirrors chk_visit_task_completions_reason exactly: a reason is required for, and only for,
// 'not_completed' - a client sending a reason alongside 'completed'/'not_applicable' would
// otherwise hit the DB CHECK as an unclassified 500 instead of a clean 400.
const putTaskCompletionRequestSchema = z
  .object({
    status: z.enum(['completed', 'not_completed', 'not_applicable']),
    reason: z
      .enum(['client_declined', 'client_unavailable', 'equipment_unavailable', 'other'])
      .optional(),
    notes: z.string().min(1).optional(),
  })
  .refine(
    (data) =>
      data.status === 'not_completed' ? data.reason !== undefined : data.reason === undefined,
    {
      message: "reason is required when status is 'not_completed', and must be omitted otherwise",
      path: ['reason'],
    },
  );

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

// Shared by both routes below: caller lookup, visit lookup, ownership, and the in_progress
// precondition - deliberately not reused from checkin.ts's own resolveCaregiverVisitOwnership
// (which requires 'scheduled', the opposite precondition) or visitSchedules.ts's checkout
// ownership block (private to that file) - a materially different status check, not the same
// helper with a parameter, so a separate small copy here is clearer than threading a status
// argument through a shared cross-file helper for one call site each.
async function resolveCaregiverInProgressVisit(
  db: Db,
  visitScheduleId: string,
  req: Request,
  res: Response,
): Promise<typeof schema.visitSchedules.$inferSelect | undefined> {
  const caller = req.auth;
  if (!caller) {
    sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
    return undefined;
  }
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
    return undefined;
  }
  if (visit.caregiverId !== callerRow.id) {
    sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
    return undefined;
  }
  if (visit.status !== 'in_progress') {
    sendProblem(res, {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: `The task checklist is only available once checked in and before checkout (current status: ${visit.status}).`,
    });
    return undefined;
  }

  return visit;
}

export function createVisitTasksRouter(dependencies: VisitTasksRouterDependencies): Router {
  const router = Router();
  const { requireAuth } = dependencies;
  router.use(requireAuth, requireRole('caregiver'));

  router.get('/:visitScheduleId/tasks', async (req, res, next) => {
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

    try {
      const visit = await resolveCaregiverInProgressVisit(db, visitScheduleId, req, res);
      if (!visit) {
        return;
      }

      const tasks = await db
        .select()
        .from(schema.dependantCareTasks)
        .where(
          and(
            eq(schema.dependantCareTasks.dependantId, visit.dependantId),
            eq(schema.dependantCareTasks.active, true),
          ),
        )
        .orderBy(asc(schema.dependantCareTasks.createdAt));

      const completions = await db
        .select()
        .from(schema.visitTaskCompletions)
        .where(eq(schema.visitTaskCompletions.visitScheduleId, visitScheduleId));
      const completionByTaskId = new Map(completions.map((row) => [row.careTaskId, row]));

      const response: VisitTaskResponse[] = tasks.map((task) => {
        const completion = completionByTaskId.get(task.id);
        return {
          careTaskId: task.id,
          title: task.title,
          description: task.description,
          category: task.category,
          required: task.required,
          status: completion?.status ?? null,
          reason: completion?.reason ?? null,
          notes: completion?.notes ?? null,
          completedAt: completion ? completion.completedAt.toISOString() : null,
        };
      });
      res.status(200).json(response);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:visitScheduleId/tasks/:careTaskId', async (req, res, next) => {
    const visitScheduleId = parseOrSendProblem(
      visitScheduleIdParamSchema,
      req.params.visitScheduleId,
      res,
    );
    if (!visitScheduleId) {
      return;
    }
    const careTaskId = parseOrSendProblem(careTaskIdParamSchema, req.params.careTaskId, res);
    if (!careTaskId) {
      return;
    }
    const body = parseOrSendProblem(putTaskCompletionRequestSchema, req.body, res);
    if (!body) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    try {
      const visit = await resolveCaregiverInProgressVisit(db, visitScheduleId, req, res);
      if (!visit) {
        return;
      }

      const [task] = await db
        .select({ id: schema.dependantCareTasks.id })
        .from(schema.dependantCareTasks)
        .where(
          and(
            eq(schema.dependantCareTasks.id, careTaskId),
            eq(schema.dependantCareTasks.dependantId, visit.dependantId),
            eq(schema.dependantCareTasks.active, true),
          ),
        );
      if (!task) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: "No active care-plan task with this id exists for this visit's dependant.",
        });
        return;
      }

      const [row] = await db
        .insert(schema.visitTaskCompletions)
        .values({
          visitScheduleId,
          careTaskId,
          status: body.status,
          reason: body.reason ?? null,
          notes: body.notes ?? null,
        })
        .onConflictDoUpdate({
          target: [
            schema.visitTaskCompletions.visitScheduleId,
            schema.visitTaskCompletions.careTaskId,
          ],
          set: {
            status: body.status,
            reason: body.reason ?? null,
            notes: body.notes ?? null,
            completedAt: new Date(),
          },
        })
        .returning();
      if (!row) {
        throw new Error('Upsert into visit_task_completions returned no row.');
      }
      res.status(200).json({
        careTaskId: row.careTaskId,
        status: row.status,
        reason: row.reason,
        notes: row.notes,
        completedAt: row.completedAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

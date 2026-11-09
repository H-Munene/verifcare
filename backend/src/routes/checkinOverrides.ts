// GET /checkin-overrides, POST /checkin-overrides/{id}/approve|deny (2026-11-09): the supervisor's
// side of the exception used when no family member is at the home to show a check-in code.
//
// Approving starts the visit, but marks it 'supervisor_override' so it never counts as fully
// verified and always appears in the Compliance tab's exceptions. A note is required either way, so
// each override records a human reason. Any supervisor may decide, the same collective
// responsibility as missed-visit alerts; deciding also acknowledges the matching alert.

import { and, asc, eq, isNull } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { requireRole } from '../auth/middleware.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { parseOrSendProblem } from '../validation.js';

export interface CheckinOverridesRouterDependencies {
  requireAuth: RequestHandler;
  now?: () => Date;
}

const overrideIdParamSchema = z.string().uuid();
const listQuerySchema = z.object({
  status: z.enum(schema.CHECKIN_OVERRIDE_STATUSES).default('pending'),
});
const decisionRequestSchema = z.object({
  note: z.string().trim().min(1).max(1000),
});

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

// Thrown inside the transaction so nothing it already did is kept when the visit has moved on.
class VisitNotAwaitingCheckin extends Error {}

export function createCheckinOverridesRouter(
  dependencies: CheckinOverridesRouterDependencies,
): Router {
  const router = Router();
  const { requireAuth } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  router.use(requireAuth, requireRole('supervisor'));

  router.get('/', async (req, res, next) => {
    const query = parseOrSendProblem(listQuerySchema, req.query, res);
    const db = query && getDb(res);
    if (!query || !db) {
      return;
    }
    try {
      const requester = alias(schema.users, 'requester');
      const rows = await db
        .select({
          request: schema.checkinOverrideRequests,
          scheduledStart: schema.visitSchedules.scheduledStart,
          scheduledEnd: schema.visitSchedules.scheduledEnd,
          dependantName: schema.dependants.fullName,
          caregiverName: requester.fullName,
        })
        .from(schema.checkinOverrideRequests)
        .innerJoin(
          schema.visitSchedules,
          eq(schema.visitSchedules.id, schema.checkinOverrideRequests.visitScheduleId),
        )
        .innerJoin(schema.dependants, eq(schema.dependants.id, schema.visitSchedules.dependantId))
        .innerJoin(requester, eq(requester.id, schema.checkinOverrideRequests.requestedBy))
        .where(eq(schema.checkinOverrideRequests.status, query.status))
        .orderBy(asc(schema.checkinOverrideRequests.requestedAt));
      res.status(200).json({
        items: rows.map(
          ({ request, scheduledStart, scheduledEnd, dependantName, caregiverName }) => ({
            id: request.id,
            visitScheduleId: request.visitScheduleId,
            reason: request.reason,
            note: request.note,
            status: request.status,
            distanceFromGeofenceMeters: request.distanceFromGeofenceMeters,
            decisionNote: request.decisionNote,
            requestedAt: request.requestedAt.toISOString(),
            decidedAt: request.decidedAt?.toISOString() ?? null,
            scheduledStart: scheduledStart.toISOString(),
            scheduledEnd: scheduledEnd.toISOString(),
            dependantName,
            caregiverName,
          }),
        ),
      });
    } catch (err) {
      next(err);
    }
  });

  const decide = (decision: 'approved' | 'denied'): RequestHandler => {
    return async (req, res, next) => {
      const id = parseOrSendProblem(overrideIdParamSchema, req.params.overrideId, res);
      if (!id) {
        return;
      }
      const body = parseOrSendProblem(decisionRequestSchema, req.body, res);
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

      try {
        const callerRow = await getUserByCognitoSub(db, caller.sub);
        if (!callerRow) {
          throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
        }
        const at = now();

        const decided = await db.transaction(async (tx) => {
          // Status in the WHERE, so if two supervisors decide at once only one takes effect.
          const [request] = await tx
            .update(schema.checkinOverrideRequests)
            .set({
              status: decision,
              decidedBy: callerRow.id,
              decisionNote: body.note,
              decidedAt: at,
            })
            .where(
              and(
                eq(schema.checkinOverrideRequests.id, id),
                eq(schema.checkinOverrideRequests.status, 'pending'),
              ),
            )
            .returning();
          if (!request) {
            return undefined;
          }

          if (decision === 'approved') {
            const [visit] = await tx
              .update(schema.visitSchedules)
              .set({ status: 'in_progress', updatedAt: at })
              .where(
                and(
                  eq(schema.visitSchedules.id, request.visitScheduleId),
                  eq(schema.visitSchedules.status, 'scheduled'),
                ),
              )
              .returning({ id: schema.visitSchedules.id });
            if (!visit) {
              throw new VisitNotAwaitingCheckin();
            }
            await tx
              .update(schema.verificationEvents)
              .set({ checkinAt: at, checkinMethod: 'supervisor_override' })
              .where(eq(schema.verificationEvents.visitScheduleId, request.visitScheduleId));
          }

          await tx
            .update(schema.notificationLog)
            .set({ acknowledgedAt: at, acknowledgedBy: callerRow.id })
            .where(
              and(
                eq(schema.notificationLog.visitScheduleId, request.visitScheduleId),
                eq(schema.notificationLog.type, 'checkin_override'),
                isNull(schema.notificationLog.acknowledgedAt),
              ),
            );
          await recordAudit(tx, {
            actorUserId: callerRow.id,
            action: decision === 'approved' ? 'checkin_override.approve' : 'checkin_override.deny',
            entityType: 'visit_schedule',
            entityId: request.visitScheduleId,
            metadata: { requestId: request.id },
          });
          return request;
        });

        if (!decided) {
          const [existing] = await db
            .select({ id: schema.checkinOverrideRequests.id })
            .from(schema.checkinOverrideRequests)
            .where(eq(schema.checkinOverrideRequests.id, id));
          if (!existing) {
            sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
            return;
          }
          sendProblem(res, {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail: 'This request has already been decided.',
          });
          return;
        }

        res.status(200).json({
          id: decided.id,
          visitScheduleId: decided.visitScheduleId,
          status: decided.status,
          decisionNote: decided.decisionNote,
          decidedAt: decided.decidedAt?.toISOString() ?? null,
        });
      } catch (err) {
        if (err instanceof VisitNotAwaitingCheckin) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail:
              'This visit is no longer awaiting check-in, so it can only be denied. Deny it with a note to close the request.',
          });
          return;
        }
        next(err);
      }
    };
  };

  router.post('/:overrideId/approve', decide('approved'));
  router.post('/:overrideId/deny', decide('denied'));

  return router;
}

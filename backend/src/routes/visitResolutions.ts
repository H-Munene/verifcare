// POST /visit-schedules/{id}/resolutions (2026-09-27, the Compliance tab's exceptions log): a
// supervisor records how a missed visit, a missing checkout or a failed check was resolved - an
// outcome and a required note - so every exception has an account of what happened. Nothing
// recorded this before. The product owner chose outcome categories plus a note over a note
// alone, so the exceptions report can be read by outcome.
//
// Resolving a missed visit moves it to `investigated` (the status that already meant "a
// supervisor looked into this"), and a visit whose end passed with no check-in that the sweep
// hasn't reached yet goes straight there too, so the sweep can't later mark it missed and raise
// an alert about something already dealt with. Other visits keep their status: a completed visit
// with a failed check was still completed. Its open missed-visit alert, if any, is acknowledged
// by the same supervisor, since resolving the visit answers the alert.
//
// Mounted at the same '/visit-schedules' prefix as a separate router, like checkin.ts and
// visitTasks.ts. Resolutions are append-only (visit_resolutions' trigger): resolving again adds a
// newer resolution that supersedes the earlier one, and both stay on record.

import { and, eq, isNull } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { requireRole } from '../auth/middleware.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import { assessVisit, visitRecords } from '../db/complianceReports.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { parseOrSendProblem } from '../validation.js';

export interface VisitResolutionsRouterDependencies {
  requireAuth: RequestHandler;
  now?: () => Date;
}

const visitScheduleIdParamSchema = z.string().uuid();

const createResolutionRequestSchema = z.object({
  outcome: z.enum(schema.VISIT_RESOLUTION_OUTCOMES),
  note: z.string().trim().min(1).max(2000),
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

export function createVisitResolutionsRouter(
  dependencies: VisitResolutionsRouterDependencies,
): Router {
  const router = Router();
  const { requireAuth } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  router.use(requireAuth);

  router.post(
    '/:visitScheduleId/resolutions',
    requireRole('supervisor'),
    async (req, res, next) => {
      const visitScheduleId = parseOrSendProblem(
        visitScheduleIdParamSchema,
        req.params.visitScheduleId,
        res,
      );
      if (!visitScheduleId) {
        return;
      }
      const body = parseOrSendProblem(createResolutionRequestSchema, req.body, res);
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
        const [visit] = await visitRecords(db, { visitScheduleId });
        if (!visit) {
          sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
          return;
        }
        const at = now();
        const { exceptionKinds } = assessVisit(visit, at);
        if (exceptionKinds.length === 0) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail:
              'Only a missed visit, a visit with no checkout, or one with a failed check can be resolved.',
          });
          return;
        }
        const callerRow = await getUserByCognitoSub(db, caller.sub);
        if (!callerRow) {
          throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
        }

        const resolution = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(schema.visitResolutions)
            .values({
              visitScheduleId,
              outcome: body.outcome,
              note: body.note,
              resolvedBy: callerRow.id,
              resolvedAt: at,
            })
            .returning();
          if (!row) {
            throw new Error('Insert into visit_resolutions returned no row.');
          }
          await recordAudit(tx, {
            actorUserId: callerRow.id,
            action: 'visit.resolve',
            entityType: 'visit_schedule',
            entityId: visitScheduleId,
            metadata: { resolutionId: row.id, outcome: body.outcome, kinds: exceptionKinds },
          });

          const noCheckinYetUnswept =
            exceptionKinds.includes('missed') && visit.status === 'scheduled';
          if (visit.status === 'missed' || noCheckinYetUnswept) {
            await tx
              .update(schema.visitSchedules)
              .set({ status: 'investigated', updatedAt: at })
              .where(eq(schema.visitSchedules.id, visitScheduleId));
            await recordAudit(tx, {
              actorUserId: callerRow.id,
              action: 'visit_schedule.update',
              entityType: 'visit_schedule',
              entityId: visitScheduleId,
              metadata: { status: { from: visit.status, to: 'investigated' } },
            });
          }

          const acknowledged = await tx
            .update(schema.notificationLog)
            .set({ acknowledgedAt: at, acknowledgedBy: callerRow.id })
            .where(
              and(
                eq(schema.notificationLog.type, 'missed_visit'),
                eq(schema.notificationLog.visitScheduleId, visitScheduleId),
                isNull(schema.notificationLog.acknowledgedAt),
              ),
            )
            .returning({ id: schema.notificationLog.id });
          for (const alert of acknowledged) {
            await recordAudit(tx, {
              actorUserId: callerRow.id,
              action: 'notification.acknowledge',
              entityType: 'notification',
              entityId: alert.id,
              metadata: { via: 'visit.resolve', visitScheduleId },
            });
          }
          return row;
        });

        res.status(201).json({
          id: resolution.id,
          visitScheduleId,
          outcome: resolution.outcome,
          note: resolution.note,
          resolvedBy: callerRow.id,
          resolvedByName: callerRow.fullName,
          resolvedAt: resolution.resolvedAt.toISOString(),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

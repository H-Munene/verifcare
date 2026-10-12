// GET /notifications, POST /notifications/{id}/acknowledge (HEZ-41).
//
// Visibility (matching openapi.yaml's own already-drafted description, not a fresh judgment
// call): a caller sees only notifications addressed to them (`recipientUserId`), except a
// supervisor sees the whole inbox regardless of who a given alert is addressed to - architecture.md
// currently only ever addresses missed-visit/cognitive-risk alerts to a supervisor, so a
// caregiver/family_member caller will simply see an empty list today, but the generic
// "recipientUserId === caller, unless supervisor" rule is implemented as described rather than
// hard-coded to "supervisor-only", in case a future notification type ever does address a
// caregiver or family member directly.
//
// Acknowledgement (confirmed with the user before implementing, not assumed): any supervisor may
// acknowledge any notification, not only the one whose recipientUserId matches the caller -
// matches openapi.yaml's own "a supervisor viewing the missed-visit alert inbox" framing
// (shared visibility, not per-recipient siloing) and architecture.md's "supervisor and
// administrator... full permissions... missed-visit handling" as one collective responsibility,
// not tied to whichever specific supervisor account an alert happened to be stamped with.
// Acknowledging is idempotent, the same reasoning as routes/consentRecords.ts's revoke: an
// already-acknowledged notification is returned unchanged rather than overwriting its real
// acknowledged_at/acknowledged_by audit values or erroring - openapi.yaml documents no error
// response for this case.

import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth/middleware.js';
import { recordAudit } from '../audit.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { cursorCondition, decodeCursor, paginate } from '../pagination.js';
import { parseOrSendProblem } from '../validation.js';

export interface NotificationsRouterDependencies {
  requireAuth: RequestHandler;
}

interface NotificationResponse {
  id: string;
  type: 'missed_visit' | 'cognitive_risk';
  visitScheduleId: string | null;
  audioRecordId: string | null;
  // null: a shared missed-visit alert, addressed to every supervisor (0016).
  recipientUserId: string | null;
  channel: string | null;
  sentAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

function toResponse(row: typeof schema.notificationLog.$inferSelect): NotificationResponse {
  return {
    id: row.id,
    type: row.type as 'missed_visit' | 'cognitive_risk',
    visitScheduleId: row.visitScheduleId,
    audioRecordId: row.audioRecordId,
    recipientUserId: row.recipientUserId,
    channel: row.channel,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
    acknowledgedBy: row.acknowledgedBy,
  };
}

const listNotificationsQuerySchema = z.object({
  type: z.enum(['missed_visit', 'cognitive_risk']).optional(),
  // Not z.coerce.boolean() - Boolean("false") is true in JS, so that would silently treat
  // ?acknowledged=false the same as ?acknowledged=true. An explicit enum + transform avoids it.
  acknowledged: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const notificationIdParamSchema = z.string().uuid();

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

export function createNotificationsRouter(dependencies: NotificationsRouterDependencies): Router {
  const router = Router();
  const { requireAuth } = dependencies;
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    const query = parseOrSendProblem(listNotificationsQuerySchema, req.query, res);
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
      if (caller.role !== 'supervisor') {
        const callerRow = await getUserByCognitoSub(db, caller.sub);
        if (!callerRow) {
          throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
        }
        conditions.push(eq(schema.notificationLog.recipientUserId, callerRow.id));
      }
      if (query.type) {
        conditions.push(eq(schema.notificationLog.type, query.type));
      }
      if (query.acknowledged !== undefined) {
        conditions.push(
          query.acknowledged
            ? isNotNull(schema.notificationLog.acknowledgedAt)
            : isNull(schema.notificationLog.acknowledgedAt),
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
        conditions.push(cursorCondition(schema.notificationLog.id, cursor));
      }

      const rows = await db
        .select()
        .from(schema.notificationLog)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(schema.notificationLog.id))
        .limit(query.limit + 1);

      const { items, nextCursor } = paginate(rows, query.limit, (row) => ({ id: row.id }));
      res.status(200).json({ items: items.map(toResponse), nextCursor });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:notificationId/acknowledge', requireRole('supervisor'), async (req, res, next) => {
    const notificationId = parseOrSendProblem(
      notificationIdParamSchema,
      req.params.notificationId,
      res,
    );
    if (!notificationId) {
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
      const [existing] = await db
        .select()
        .from(schema.notificationLog)
        .where(eq(schema.notificationLog.id, notificationId));
      if (!existing) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }

      if (existing.acknowledgedAt) {
        res.status(200).json(toResponse(existing));
        return;
      }

      const callerRow = await getUserByCognitoSub(db, caller.sub);
      if (!callerRow) {
        throw new Error(`No users row found for authenticated caller sub ${caller.sub}.`);
      }

      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.notificationLog)
          .set({ acknowledgedAt: new Date(), acknowledgedBy: callerRow.id })
          .where(eq(schema.notificationLog.id, notificationId))
          .returning();
        if (!row) {
          throw new Error('Update to notification_log returned no row.');
        }
        await recordAudit(tx, {
          actorUserId: callerRow.id,
          action: 'notification.acknowledge',
          entityType: 'notification',
          entityId: notificationId,
          metadata: { type: existing.type },
        });
        return row;
      });
      res.status(200).json(toResponse(updated));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

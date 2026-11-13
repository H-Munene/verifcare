// The caregiver's half of check-in (HEZ-33, reworked 2026-11-09 when QR codes replaced face
// matching). Mounted at the same `/visit-schedules` prefix as routes/visitSchedules.ts, but kept as
// its own router because check-in authenticates its later steps with both the caller's Cognito ID
// token and the session token the geofence step issues (see auth/checkinSession.ts).
//
// The flow:
// 1. POST .../checkin/geofence: the caregiver's phone is at the home; issues a session token.
// 2. POST .../checkin/qr-scan: the caregiver scans the code on a family member's phone
//    (routes/checkinCode.ts issues it). This is what starts the visit.
// 3. If no family member is at the home, POST .../checkin/override asks a supervisor to let the
//    visit start instead (routes/checkinOverrides.ts decides it).
//
// Why a code rather than a face: facial biometrics were judged too invasive for what they add. The
// code is random, valid for about a minute, single-use and bound to one visit, and it can only be
// issued by a family member linked to this dependant whose phone is itself at the home. So a
// screenshot can't be replayed later or used at another home, and two independent devices have to
// be at the address. What it doesn't prove is who is holding the caregiver's phone: that rests on
// their login and on the family member recognising them.
//
// RBAC: caregiver-only, and only for a visit they're the assigned caregiver on. Every attempt, pass
// or fail, writes a verification_attempts row so the audit trail explains why a failure happened.
//
// This router's router.use(requireRole('caregiver')) rejects every other role that reaches it, so
// any route other roles need under this prefix must be mounted before it (see app.ts).

import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { resolveCheckinSession, SESSION_TOKEN_HEADER } from '../auth/checkinSession.js';
import { requireRole } from '../auth/middleware.js';
import { generateSessionToken, hashSessionToken } from '../auth/sessionToken.js';
import { assessPosition, devicePositionSchema, positionFailureDetail } from '../checkinPosition.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import { isPostgresUniqueViolation } from '../db/postgresErrors.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { parseOrSendProblem } from '../validation.js';

export interface CheckinRouterDependencies {
  requireAuth: RequestHandler;
  geofenceAccuracyThresholdMeters: number;
  sessionTokenTtlSeconds: number;
}

// Express 5's params type allows string | string[], so req.params.visitScheduleId isn't a plain
// string on its own - validated the same way any other input is, via parseOrSendProblem.
const visitScheduleIdParamSchema = z.string().uuid();

const qrScanRequestSchema = z.object({
  token: z.string().min(1).max(200),
});

const overrideRequestSchema = z
  .object({
    reason: z.enum(schema.CHECKIN_OVERRIDE_REASONS),
    note: z.string().trim().max(500).optional(),
  })
  .refine((body) => body.reason !== 'other' || (body.note?.length ?? 0) > 0, {
    message: "A note is required when the reason is 'other'.",
    path: ['note'],
  });

type QrFailureReason = 'invalid_qr' | 'expired_qr' | 'used_qr';

function qrFailureDetail(reason: QrFailureReason): string {
  switch (reason) {
    case 'invalid_qr':
      return "This code isn't for this visit. Ask the family member to open the check-in code for this visit.";
    case 'expired_qr':
      return 'This code has expired. Scan the new code on the family member’s phone.';
    case 'used_qr':
      return 'This code has already been used. Scan the new code on the family member’s phone.';
  }
}

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

// "Is this caller the assigned caregiver on a still-'scheduled' visit". Sends the error response
// itself and returns undefined on any failure.
async function resolveCaregiverVisitOwnership(
  db: Db,
  visitScheduleId: string,
  req: Request,
  res: Response,
): Promise<
  | {
      callerRow: typeof schema.users.$inferSelect;
      visit: typeof schema.visitSchedules.$inferSelect;
    }
  | undefined
> {
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
  if (visit.status !== 'scheduled') {
    sendProblem(res, {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: `This visit is not awaiting check-in (current status: ${visit.status}).`,
    });
    return undefined;
  }

  return { callerRow, visit };
}

// Ownership, then the check-in session token: required in addition to Cognito auth, not instead.
async function resolveCaregiverCheckinContext(
  db: Db,
  visitScheduleId: string,
  req: Request,
  res: Response,
  sessionTokenTtlSeconds: number,
): Promise<
  | {
      callerRow: typeof schema.users.$inferSelect;
      visit: typeof schema.visitSchedules.$inferSelect;
      event: typeof schema.verificationEvents.$inferSelect;
    }
  | undefined
> {
  const ownership = await resolveCaregiverVisitOwnership(db, visitScheduleId, req, res);
  if (!ownership) {
    return undefined;
  }
  const event = await resolveCheckinSession(
    db,
    visitScheduleId,
    req.headers[SESSION_TOKEN_HEADER],
    sessionTokenTtlSeconds,
    res,
  );
  if (!event) {
    return undefined;
  }
  return { ...ownership, event };
}

function toOverrideResponse(row: typeof schema.checkinOverrideRequests.$inferSelect) {
  return {
    id: row.id,
    visitScheduleId: row.visitScheduleId,
    reason: row.reason,
    note: row.note,
    status: row.status,
    decisionNote: row.decisionNote,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

export function createCheckinRouter(dependencies: CheckinRouterDependencies): Router {
  const router = Router();
  const { requireAuth, geofenceAccuracyThresholdMeters, sessionTokenTtlSeconds } = dependencies;
  router.use(requireAuth, requireRole('caregiver'));

  router.post('/:visitScheduleId/checkin/geofence', async (req, res, next) => {
    const visitScheduleId = parseOrSendProblem(
      visitScheduleIdParamSchema,
      req.params.visitScheduleId,
      res,
    );
    if (!visitScheduleId) {
      return;
    }
    const body = parseOrSendProblem(devicePositionSchema, req.body, res);
    if (!body) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    try {
      const ownership = await resolveCaregiverVisitOwnership(db, visitScheduleId, req, res);
      if (!ownership) {
        return;
      }
      const { visit } = ownership;

      const [dependant] = await db
        .select({
          geofenceLat: schema.dependants.geofenceLat,
          geofenceLng: schema.dependants.geofenceLng,
          geofenceRadiusMeters: schema.dependants.geofenceRadiusMeters,
        })
        .from(schema.dependants)
        .where(eq(schema.dependants.id, visit.dependantId));
      if (!dependant) {
        throw new Error(`visit_schedules ${visitScheduleId} references a nonexistent dependant.`);
      }

      const { distanceMeters, failureReason } = assessPosition(
        body,
        dependant,
        geofenceAccuracyThresholdMeters,
      );

      const now = new Date();
      await db.insert(schema.verificationAttempts).values({
        id: uuidv7(),
        visitScheduleId,
        attemptType: 'geofence',
        passed: !failureReason,
        failureReason: failureReason ?? null,
        metadata: {
          gpsLat: body.gpsLat,
          gpsLng: body.gpsLng,
          accuracyMeters: body.accuracyMeters,
          isMockLocation: body.isMockLocation,
          distanceFromGeofenceMeters: distanceMeters,
        },
        attemptedAt: now,
      });

      if (failureReason) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: positionFailureDetail(failureReason),
          failureReason,
        });
        return;
      }

      // Re-issuing overwrites the hash, so calling this again invalidates the previous token.
      const { token, hash } = generateSessionToken();
      await db
        .insert(schema.verificationEvents)
        .values({
          visitScheduleId,
          checkinGpsLat: body.gpsLat,
          checkinGpsLng: body.gpsLng,
          distanceFromGeofenceMeters: distanceMeters,
          sessionTokenHash: hash,
          sessionTokenIssuedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.verificationEvents.visitScheduleId,
          set: {
            checkinGpsLat: body.gpsLat,
            checkinGpsLng: body.gpsLng,
            distanceFromGeofenceMeters: distanceMeters,
            sessionTokenHash: hash,
            sessionTokenIssuedAt: now,
          },
        });

      res.status(200).json({
        sessionToken: token,
        distanceFromGeofenceMeters: distanceMeters,
        expiresAt: new Date(now.getTime() + sessionTokenTtlSeconds * 1000).toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET .../checkin/context: view-only, before the geofence step (no session token exists yet), so
  // the check-in map can show the home and its circle. Deliberately narrow: only what's needed to
  // reach the right home, which is why it doesn't widen routes/dependants.ts's RBAC to caregivers.
  router.get('/:visitScheduleId/checkin/context', async (req, res, next) => {
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
      const ownership = await resolveCaregiverVisitOwnership(db, visitScheduleId, req, res);
      if (!ownership) {
        return;
      }
      const { visit } = ownership;

      const [dependant] = await db
        .select({
          fullName: schema.dependants.fullName,
          homeAddressText: schema.dependants.homeAddressText,
          geofenceLat: schema.dependants.geofenceLat,
          geofenceLng: schema.dependants.geofenceLng,
          geofenceRadiusMeters: schema.dependants.geofenceRadiusMeters,
        })
        .from(schema.dependants)
        .where(eq(schema.dependants.id, visit.dependantId));
      if (!dependant) {
        throw new Error(`visit_schedules ${visitScheduleId} references a nonexistent dependant.`);
      }

      res.status(200).json({
        dependantDisplayName: dependant.fullName,
        dependantHomeAddressText: dependant.homeAddressText,
        geofenceLat: dependant.geofenceLat,
        geofenceLng: dependant.geofenceLng,
        geofenceRadiusMeters: dependant.geofenceRadiusMeters,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:visitScheduleId/checkin/qr-scan', async (req, res, next) => {
    const visitScheduleId = parseOrSendProblem(
      visitScheduleIdParamSchema,
      req.params.visitScheduleId,
      res,
    );
    if (!visitScheduleId) {
      return;
    }
    const body = parseOrSendProblem(qrScanRequestSchema, req.body, res);
    if (!body) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    try {
      const context = await resolveCaregiverCheckinContext(
        db,
        visitScheduleId,
        req,
        res,
        sessionTokenTtlSeconds,
      );
      if (!context) {
        return;
      }
      const { callerRow } = context;
      const now = new Date();

      const refuse = async (failureReason: QrFailureReason): Promise<void> => {
        await db.insert(schema.verificationAttempts).values({
          id: uuidv7(),
          visitScheduleId,
          attemptType: 'qr_scan',
          passed: false,
          failureReason,
          attemptedAt: now,
        });
        sendProblem(res, {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: qrFailureDetail(failureReason),
          failureReason,
        });
      };

      const [code] = await db
        .select()
        .from(schema.checkinQrTokens)
        .where(eq(schema.checkinQrTokens.tokenHash, hashSessionToken(body.token)));
      // A code for another visit is reported the same as a meaningless one, so a scan reveals
      // nothing about other visits.
      if (!code || code.visitScheduleId !== visitScheduleId || code.purpose !== 'checkin') {
        await refuse('invalid_qr');
        return;
      }
      if (code.consumedAt) {
        await refuse('used_qr');
        return;
      }
      if (code.expiresAt <= now) {
        await refuse('expired_qr');
        return;
      }

      // The UPDATEs are what decide, not the reads above: two simultaneous scans can both pass
      // those reads, but only one can consume the code and start the visit.
      const started = await db.transaction(async (tx) => {
        const [consumed] = await tx
          .update(schema.checkinQrTokens)
          .set({ consumedAt: now })
          .where(
            and(
              eq(schema.checkinQrTokens.id, code.id),
              isNull(schema.checkinQrTokens.consumedAt),
              gt(schema.checkinQrTokens.expiresAt, now),
            ),
          )
          .returning({ id: schema.checkinQrTokens.id });
        if (!consumed) {
          return false;
        }
        const [flipped] = await tx
          .update(schema.visitSchedules)
          .set({ status: 'in_progress', updatedAt: now })
          .where(
            and(
              eq(schema.visitSchedules.id, visitScheduleId),
              eq(schema.visitSchedules.status, 'scheduled'),
            ),
          )
          .returning({ id: schema.visitSchedules.id });
        if (!flipped) {
          return false;
        }
        await tx
          .update(schema.verificationEvents)
          .set({
            checkinAt: now,
            checkinMethod: 'qr',
            qrFamilyMemberUserId: code.familyMemberUserId,
            familyDistanceFromGeofenceMeters: code.distanceFromGeofenceMeters,
          })
          .where(eq(schema.verificationEvents.visitScheduleId, visitScheduleId));
        await tx.insert(schema.verificationAttempts).values({
          id: uuidv7(),
          visitScheduleId,
          attemptType: 'qr_scan',
          passed: true,
          failureReason: null,
          metadata: { familyMemberUserId: code.familyMemberUserId },
          attemptedAt: now,
        });
        await recordAudit(tx, {
          actorUserId: callerRow.id,
          action: 'visit.checkin',
          entityType: 'visit_schedule',
          entityId: visitScheduleId,
          metadata: { method: 'qr', familyMemberUserId: code.familyMemberUserId },
        });
        return true;
      });

      if (!started) {
        await refuse('used_qr');
        return;
      }
      res.status(200).json({ status: 'in_progress', checkinAt: now.toISOString() });
    } catch (err) {
      next(err);
    }
  });

  // POST .../checkin/override: no family member can show a code, so the caregiver, already proven
  // to be at the home by the session token, asks a supervisor to start the visit.
  router.post('/:visitScheduleId/checkin/override', async (req, res, next) => {
    const visitScheduleId = parseOrSendProblem(
      visitScheduleIdParamSchema,
      req.params.visitScheduleId,
      res,
    );
    if (!visitScheduleId) {
      return;
    }
    const body = parseOrSendProblem(overrideRequestSchema, req.body, res);
    if (!body) {
      return;
    }
    const db = getDb(res);
    if (!db) {
      return;
    }

    try {
      const context = await resolveCaregiverCheckinContext(
        db,
        visitScheduleId,
        req,
        res,
        sessionTokenTtlSeconds,
      );
      if (!context) {
        return;
      }
      const { callerRow, event } = context;
      const now = new Date();

      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.checkinOverrideRequests)
          .values({
            visitScheduleId,
            requestedBy: callerRow.id,
            reason: body.reason,
            note: body.note || null,
            distanceFromGeofenceMeters: event.distanceFromGeofenceMeters ?? 0,
            requestedAt: now,
          })
          .returning();
        if (!row) {
          throw new Error('Insert into checkin_override_requests returned no row.');
        }
        await tx.insert(schema.notificationLog).values({
          type: 'checkin_override',
          visitScheduleId,
          recipientUserId: null,
          channel: 'in_app',
          sentAt: now,
        });
        await recordAudit(tx, {
          actorUserId: callerRow.id,
          action: 'checkin_override.request',
          entityType: 'visit_schedule',
          entityId: visitScheduleId,
          metadata: { requestId: row.id, reason: body.reason },
        });
        return row;
      });
      res.status(201).json(toOverrideResponse(created));
    } catch (err) {
      if (isPostgresUniqueViolation(err)) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'A request for this visit is already waiting for a supervisor.',
        });
        return;
      }
      next(err);
    }
  });

  // GET .../checkin/override: the caregiver app polls this for the decision. Not limited to
  // 'scheduled' visits, because an approved request has already moved the visit to in_progress.
  router.get('/:visitScheduleId/checkin/override', async (req, res, next) => {
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
      const callerRow = await getUserByCognitoSub(db, caller.sub);
      const [visit] = await db
        .select({ caregiverId: schema.visitSchedules.caregiverId })
        .from(schema.visitSchedules)
        .where(eq(schema.visitSchedules.id, visitScheduleId));
      if (!visit) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      if (visit.caregiverId !== callerRow?.id) {
        sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
        return;
      }
      const [latest] = await db
        .select()
        .from(schema.checkinOverrideRequests)
        .where(eq(schema.checkinOverrideRequests.visitScheduleId, visitScheduleId))
        .orderBy(desc(schema.checkinOverrideRequests.requestedAt))
        .limit(1);
      if (!latest) {
        sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
        return;
      }
      res.status(200).json(toOverrideResponse(latest));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

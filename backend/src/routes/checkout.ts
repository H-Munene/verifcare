// Check-out (2026-11-13), the caregiver's side. Two steps, like check-in:
//
// 1. POST .../checkout/request: every requirement is met (inside the home's radius, required tasks
//    addressed, the dependant recorded or their recording explained), so the family is asked to confirm.
// 2. The family member's phone shows a code (routes/checkinCode.ts's .../checkout/qr), and the
//    caregiver scans it (.../checkout/qr-scan) or types its 6 digits (.../checkout/code). If neither
//    is possible, .../checkout/override completes the visit at once with a reason, so the caregiver
//    is never kept waiting; supervisors see the reason afterwards.
//
// Each completing step re-checks the caregiver's position, since time can pass between the steps.

import { and, desc, eq, gt, gte, isNull } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { requireRole } from '../auth/middleware.js';
import { hashSessionToken } from '../auth/sessionToken.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { haversineDistanceMeters } from '../geo.js';
import { parseOrSendProblem } from '../validation.js';
import { recordingRequirements } from './visitAudio.js';

export interface CheckoutRouterDependencies {
  requireAuth: RequestHandler;
  now?: () => Date;
}

// Wrong 6-digit codes allowed per visit in the window before typing is refused for a while.
const MAX_CODE_FAILURES = 5;
const CODE_FAILURE_WINDOW_MS = 10 * 60 * 1000;

/** The stored form of a family code's 6 digits (check-in or check-out), bound to its visit. */
export function visitCodeHash(visitScheduleId: string, code: string): string {
  // ponytail: an unsalted hash of a 6-digit code is reversible by anyone who can read the table;
  // the code lives 60 s and guessing online is capped, so a keyed HMAC is the upgrade if needed.
  return hashSessionToken(`${visitScheduleId}:${code}`);
}

const visitScheduleIdParamSchema = z.string().uuid();
const positionSchema = {
  gpsLat: z.number().min(-90).max(90),
  gpsLng: z.number().min(-180).max(180),
};
const requestSchema = z
  .object({
    ...positionSchema,
    audioSkipReason: z.enum(schema.AUDIO_SKIP_REASONS).optional(),
    audioSkipNote: z.string().trim().max(500).optional(),
  })
  .refine((body) => body.audioSkipReason !== 'other' || (body.audioSkipNote?.length ?? 0) > 0, {
    message: "A note is required when the reason is 'other'.",
    path: ['audioSkipNote'],
  });
const qrScanSchema = z.object({ ...positionSchema, token: z.string().min(1).max(200) });
const codeSchema = z.object({
  ...positionSchema,
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code.'),
});
const overrideSchema = z
  .object({
    ...positionSchema,
    reason: z.enum(schema.CHECKOUT_OVERRIDE_REASONS),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((body) => body.reason !== 'other' || (body.note?.length ?? 0) > 0, {
    message: "A note is required when the reason is 'other'.",
    path: ['note'],
  });

type CodeFailureReason = 'invalid_code' | 'expired_code' | 'used_code';

// Thrown inside the transaction so nothing it already did is kept when another attempt won.
class AlreadyCompleted extends Error {}

function codeFailureDetail(reason: CodeFailureReason): string {
  switch (reason) {
    case 'invalid_code':
      return "This code isn't for this visit's check-out. Ask the family member to open the check-out code.";
    case 'expired_code':
      return 'This code has expired. Use the new code on the family member’s phone.';
    case 'used_code':
      return 'This code has already been used. Use the new code on the family member’s phone.';
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

export function createCheckoutRouter(dependencies: CheckoutRouterDependencies): Router {
  const router = Router();
  const { requireAuth } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const caregiverOnly = [requireAuth, requireRole('caregiver')];

  // The caller's own visit, under way, with its home and check-out state. Sends the error and
  // returns undefined otherwise.
  async function loadVisit(db: Db, visitScheduleId: string, callerSub: string, res: Response) {
    const callerRow = await getUserByCognitoSub(db, callerSub);
    const [row] = await db
      .select({
        visit: schema.visitSchedules,
        home: {
          geofenceLat: schema.dependants.geofenceLat,
          geofenceLng: schema.dependants.geofenceLng,
          geofenceRadiusMeters: schema.dependants.geofenceRadiusMeters,
        },
        checkoutRequestedAt: schema.verificationEvents.checkoutRequestedAt,
      })
      .from(schema.visitSchedules)
      .innerJoin(schema.dependants, eq(schema.dependants.id, schema.visitSchedules.dependantId))
      .leftJoin(
        schema.verificationEvents,
        eq(schema.verificationEvents.visitScheduleId, schema.visitSchedules.id),
      )
      .where(eq(schema.visitSchedules.id, visitScheduleId));
    if (!row) {
      sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
      return undefined;
    }
    if (!callerRow || row.visit.caregiverId !== callerRow.id) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Only the assigned caregiver may check out of a visit.',
      });
      return undefined;
    }
    if (row.visit.status !== 'in_progress') {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `This visit hasn't been checked in yet, or is already completed/cancelled (current status: ${row.visit.status}).`,
      });
      return undefined;
    }
    return { ...row, callerRow };
  }

  // Inside the home's radius, measured as at check-in. Sends the error and returns undefined otherwise.
  function distanceInside(
    body: { gpsLat: number; gpsLng: number },
    home: { geofenceLat: number; geofenceLng: number; geofenceRadiusMeters: number },
    res: Response,
  ): number | undefined {
    const distanceMeters = haversineDistanceMeters(
      body.gpsLat,
      body.gpsLng,
      home.geofenceLat,
      home.geofenceLng,
    );
    if (distanceMeters > home.geofenceRadiusMeters) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `You're ${Math.round(distanceMeters)} m from the dependant's home, outside its ${home.geofenceRadiusMeters} m check-out radius. Check out from the home.`,
      });
      return undefined;
    }
    return distanceMeters;
  }

  // Loads the visit for a completing step and checks it's ready. Sends the error otherwise.
  async function loadForCompletion(
    db: Db,
    visitScheduleId: string,
    req: Parameters<RequestHandler>[0],
    body: { gpsLat: number; gpsLng: number },
    res: Response,
  ) {
    const loaded = await loadVisit(db, visitScheduleId, req.auth!.sub, res);
    if (!loaded) {
      return undefined;
    }
    if (!loaded.checkoutRequestedAt) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'Start check-out first, so its requirements are checked.',
      });
      return undefined;
    }
    const distanceMeters = distanceInside(body, loaded.home, res);
    return distanceMeters === undefined ? undefined : { ...loaded, distanceMeters };
  }

  type Completion =
    | {
        method: 'qr' | 'code';
        codeId: string;
        familyMemberUserId: string;
        familyDistance: number | null;
      }
    | { method: 'override'; reason: schema.CheckoutOverrideReason; note: string | null };

  // Completes the visit. The UPDATEs decide, not earlier reads: of two simultaneous attempts, only
  // one can consume the code and complete the visit. Returns false if another attempt won, having
  // kept nothing.
  async function complete(
    db: Db,
    visitScheduleId: string,
    actorUserId: string,
    body: { gpsLat: number; gpsLng: number },
    distanceMeters: number,
    completion: Completion,
    at: Date,
  ): Promise<boolean> {
    try {
      await completeIn(db, visitScheduleId, actorUserId, body, distanceMeters, completion, at);
      return true;
    } catch (err) {
      if (err instanceof AlreadyCompleted) {
        return false;
      }
      throw err;
    }
  }

  async function completeIn(
    db: Db,
    visitScheduleId: string,
    actorUserId: string,
    body: { gpsLat: number; gpsLng: number },
    distanceMeters: number,
    completion: Completion,
    at: Date,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      if (completion.method !== 'override') {
        const [consumed] = await tx
          .update(schema.checkinQrTokens)
          .set({ consumedAt: at })
          .where(
            and(
              eq(schema.checkinQrTokens.id, completion.codeId),
              isNull(schema.checkinQrTokens.consumedAt),
              gt(schema.checkinQrTokens.expiresAt, at),
            ),
          )
          .returning({ id: schema.checkinQrTokens.id });
        if (!consumed) {
          throw new AlreadyCompleted();
        }
      }
      const [completed] = await tx
        .update(schema.visitSchedules)
        .set({ status: 'completed', updatedAt: at })
        .where(
          and(
            eq(schema.visitSchedules.id, visitScheduleId),
            eq(schema.visitSchedules.status, 'in_progress'),
          ),
        )
        .returning({ id: schema.visitSchedules.id });
      if (!completed) {
        throw new AlreadyCompleted();
      }
      const family = completion.method !== 'override';
      await tx
        .update(schema.verificationEvents)
        .set({
          checkoutAt: at,
          checkoutGpsLat: body.gpsLat,
          checkoutGpsLng: body.gpsLng,
          checkoutDistanceFromGeofenceMeters: distanceMeters,
          checkoutMethod: completion.method,
          checkoutFamilyMemberUserId: family ? completion.familyMemberUserId : null,
          checkoutFamilyDistanceMeters: family ? completion.familyDistance : null,
          checkoutOverrideReason: family ? null : completion.reason,
          checkoutOverrideNote: family ? null : completion.note,
        })
        .where(eq(schema.verificationEvents.visitScheduleId, visitScheduleId));
      if (family) {
        await tx.insert(schema.verificationAttempts).values({
          id: uuidv7(),
          visitScheduleId,
          attemptType: completion.method === 'qr' ? 'checkout_qr' : 'checkout_code',
          passed: true,
          failureReason: null,
          metadata: { familyMemberUserId: completion.familyMemberUserId },
          attemptedAt: at,
        });
      }
      // Distance, not the raw GPS fix itself, which is never copied into the log verbatim.
      await recordAudit(tx, {
        actorUserId,
        action: 'visit.checkout',
        entityType: 'visit_schedule',
        entityId: visitScheduleId,
        metadata: family
          ? {
              method: completion.method,
              familyMemberUserId: completion.familyMemberUserId,
              distanceMeters: Math.round(distanceMeters),
            }
          : {
              method: 'override',
              reason: completion.reason,
              distanceMeters: Math.round(distanceMeters),
            },
      });
    });
  }

  function sendCompleted(res: Response, at: Date, method: schema.CheckoutMethod) {
    res
      .status(200)
      .json({ status: 'completed', checkoutAt: at.toISOString(), checkoutMethod: method });
  }

  router.post('/:visitScheduleId/checkout/request', ...caregiverOnly, async (req, res, next) => {
    const visitScheduleId = parseOrSendProblem(
      visitScheduleIdParamSchema,
      req.params.visitScheduleId,
      res,
    );
    const body = visitScheduleId && parseOrSendProblem(requestSchema, req.body, res);
    const db = body && getDb(res);
    if (!visitScheduleId || !body || !db) {
      return;
    }
    try {
      const loaded = await loadVisit(db, visitScheduleId, req.auth!.sub, res);
      if (!loaded || distanceInside(body, loaded.home, res) === undefined) {
        return;
      }

      // Visit task checklist (docs/visit-task-checklist-plan.md): a required, active task with no
      // completion row for this visit blocks check-out, per the user's own explicit choice.
      // "Addressed" means any status was recorded, not that every task was done.
      const missingRequiredTasks = await db
        .select({ title: schema.dependantCareTasks.title })
        .from(schema.dependantCareTasks)
        .leftJoin(
          schema.visitTaskCompletions,
          and(
            eq(schema.visitTaskCompletions.careTaskId, schema.dependantCareTasks.id),
            eq(schema.visitTaskCompletions.visitScheduleId, visitScheduleId),
          ),
        )
        .where(
          and(
            eq(schema.dependantCareTasks.dependantId, loaded.visit.dependantId),
            eq(schema.dependantCareTasks.active, true),
            eq(schema.dependantCareTasks.required, true),
            isNull(schema.visitTaskCompletions.visitScheduleId),
          ),
        );
      if (missingRequiredTasks.length > 0) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: `The following required tasks must be addressed before checkout: ${missingRequiredTasks.map((t) => t.title).join(', ')}.`,
        });
        return;
      }

      const recordings = await recordingRequirements(db, loaded.visit);
      const dependantMissing = recordings.dependant.required && !recordings.dependant.recorded;
      if (dependantMissing && !body.audioSkipReason) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: "Record the dependant's voice, or give a reason for not having it, to check out.",
          failureReason: 'dependant_recording_required',
        });
        return;
      }
      // A reason only means something when there's no recording to explain.
      const skip = dependantMissing ? body.audioSkipReason : undefined;

      const at = now();
      await db.transaction(async (tx) => {
        await tx
          .update(schema.verificationEvents)
          .set({
            checkoutRequestedAt: at,
            audioSkipReason: skip ?? null,
            audioSkipNote: skip ? body.audioSkipNote || null : null,
          })
          .where(eq(schema.verificationEvents.visitScheduleId, visitScheduleId));
        await recordAudit(tx, {
          actorUserId: loaded.callerRow.id,
          action: 'visit.checkout_request',
          entityType: 'visit_schedule',
          entityId: visitScheduleId,
          metadata: { dependantRecording: skip ?? 'recorded' },
        });
      });
      res
        .status(200)
        .json({ status: 'awaiting_confirmation', checkoutRequestedAt: at.toISOString() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:visitScheduleId/checkout/qr-scan', ...caregiverOnly, async (req, res, next) => {
    const visitScheduleId = parseOrSendProblem(
      visitScheduleIdParamSchema,
      req.params.visitScheduleId,
      res,
    );
    const body = visitScheduleId && parseOrSendProblem(qrScanSchema, req.body, res);
    const db = body && getDb(res);
    if (!visitScheduleId || !body || !db) {
      return;
    }
    try {
      const loaded = await loadForCompletion(db, visitScheduleId, req, body, res);
      if (!loaded) {
        return;
      }
      const at = now();
      const refuse = async (failureReason: CodeFailureReason) => {
        await db.insert(schema.verificationAttempts).values({
          id: uuidv7(),
          visitScheduleId,
          attemptType: 'checkout_qr',
          passed: false,
          failureReason,
          attemptedAt: at,
        });
        sendProblem(res, {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: codeFailureDetail(failureReason),
          failureReason,
        });
      };
      const [code] = await db
        .select()
        .from(schema.checkinQrTokens)
        .where(eq(schema.checkinQrTokens.tokenHash, hashSessionToken(body.token)));
      // Another visit's code, or a check-in code, reads the same as a meaningless one.
      if (!code || code.visitScheduleId !== visitScheduleId || code.purpose !== 'checkout') {
        await refuse('invalid_code');
        return;
      }
      if (code.consumedAt) {
        await refuse('used_code');
        return;
      }
      if (code.expiresAt <= at) {
        await refuse('expired_code');
        return;
      }
      const done = await complete(
        db,
        visitScheduleId,
        loaded.callerRow.id,
        body,
        loaded.distanceMeters,
        {
          method: 'qr',
          codeId: code.id,
          familyMemberUserId: code.familyMemberUserId,
          familyDistance: code.distanceFromGeofenceMeters,
        },
        at,
      );
      if (!done) {
        await refuse('used_code');
        return;
      }
      sendCompleted(res, at, 'qr');
    } catch (err) {
      next(err);
    }
  });

  router.post('/:visitScheduleId/checkout/code', ...caregiverOnly, async (req, res, next) => {
    const visitScheduleId = parseOrSendProblem(
      visitScheduleIdParamSchema,
      req.params.visitScheduleId,
      res,
    );
    const body = visitScheduleId && parseOrSendProblem(codeSchema, req.body, res);
    const db = body && getDb(res);
    if (!visitScheduleId || !body || !db) {
      return;
    }
    try {
      const loaded = await loadForCompletion(db, visitScheduleId, req, body, res);
      if (!loaded) {
        return;
      }
      const at = now();
      const failures = await db
        .select({ id: schema.verificationAttempts.id })
        .from(schema.verificationAttempts)
        .where(
          and(
            eq(schema.verificationAttempts.visitScheduleId, visitScheduleId),
            eq(schema.verificationAttempts.attemptType, 'checkout_code'),
            eq(schema.verificationAttempts.passed, false),
            gte(
              schema.verificationAttempts.attemptedAt,
              new Date(at.getTime() - CODE_FAILURE_WINDOW_MS),
            ),
          ),
        );
      if (failures.length >= MAX_CODE_FAILURES) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Too Many Requests',
          status: 429,
          detail:
            'Too many wrong codes. Scan the QR code instead, or wait 10 minutes before typing again.',
        });
        return;
      }
      const refuse = async (failureReason: CodeFailureReason) => {
        await db.insert(schema.verificationAttempts).values({
          id: uuidv7(),
          visitScheduleId,
          attemptType: 'checkout_code',
          passed: false,
          failureReason,
          attemptedAt: at,
        });
        sendProblem(res, {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: `${codeFailureDetail(failureReason)} ${MAX_CODE_FAILURES - failures.length - 1} tries left.`,
          failureReason,
        });
      };
      const [code] = await db
        .select()
        .from(schema.checkinQrTokens)
        .where(
          and(
            eq(schema.checkinQrTokens.visitScheduleId, visitScheduleId),
            eq(schema.checkinQrTokens.purpose, 'checkout'),
            eq(schema.checkinQrTokens.codeHash, visitCodeHash(visitScheduleId, body.code)),
          ),
        )
        // Newest first: should the same digits ever recur, an old expired code mustn't hide a live one.
        .orderBy(desc(schema.checkinQrTokens.issuedAt))
        .limit(1);
      if (!code) {
        await refuse('invalid_code');
        return;
      }
      if (code.consumedAt) {
        await refuse('used_code');
        return;
      }
      if (code.expiresAt <= at) {
        await refuse('expired_code');
        return;
      }
      const done = await complete(
        db,
        visitScheduleId,
        loaded.callerRow.id,
        body,
        loaded.distanceMeters,
        {
          method: 'code',
          codeId: code.id,
          familyMemberUserId: code.familyMemberUserId,
          familyDistance: code.distanceFromGeofenceMeters,
        },
        at,
      );
      if (!done) {
        await refuse('used_code');
        return;
      }
      sendCompleted(res, at, 'code');
    } catch (err) {
      next(err);
    }
  });

  router.post('/:visitScheduleId/checkout/override', ...caregiverOnly, async (req, res, next) => {
    const visitScheduleId = parseOrSendProblem(
      visitScheduleIdParamSchema,
      req.params.visitScheduleId,
      res,
    );
    const body = visitScheduleId && parseOrSendProblem(overrideSchema, req.body, res);
    const db = body && getDb(res);
    if (!visitScheduleId || !body || !db) {
      return;
    }
    try {
      const loaded = await loadForCompletion(db, visitScheduleId, req, body, res);
      if (!loaded) {
        return;
      }
      const at = now();
      const done = await complete(
        db,
        visitScheduleId,
        loaded.callerRow.id,
        body,
        loaded.distanceMeters,
        { method: 'override', reason: body.reason, note: body.note || null },
        at,
      );
      if (!done) {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'This visit has already been checked out.',
        });
        return;
      }
      sendCompleted(res, at, 'override');
    } catch (err) {
      next(err);
    }
  });

  return router;
}

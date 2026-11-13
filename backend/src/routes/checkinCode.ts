// POST /visit-schedules/{id}/checkin/qr (2026-11-09): a family member's phone asks for the code the
// caregiver will scan to start the visit (routes/checkin.ts's qr-scan consumes it).
//
// POST /visit-schedules/{id}/checkout/qr (2026-11-13): the same, to confirm check-out once the
// caregiver has requested it (routes/checkout.ts consumes it). Only the family member whose code
// started the visit may confirm it, or any linked one when a supervisor override started it. A
// check-out code also carries 6 digits, for when the caregiver's camera can't scan.
//
// The family phone's own position is checked, by the same rule as the caregiver's, before a code is
// issued. Without that, a relative anywhere could forward a live code to a caregiver who never
// reached the home's front door. Only the pass result and distance are kept, because the only
// question about a family member's location is whether they were at the home.
//
// Mounted before routes/checkin.ts, whose router-wide requireRole('caregiver') would otherwise
// reject family members.

import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { requireRole } from '../auth/middleware.js';
import { generateSessionToken } from '../auth/sessionToken.js';
import { assessPosition, devicePositionSchema, positionFailureDetail } from '../checkinPosition.js';
import type { Db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { parseOrSendProblem } from '../validation.js';
import { checkoutCodeHash } from './checkout.js';
import { findFamilyMemberLink } from './dependants.js';

export interface CheckinCodeRouterDependencies {
  requireAuth: RequestHandler;
  geofenceAccuracyThresholdMeters: number;
  qrTokenTtlSeconds: number;
}

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

export function createCheckinCodeRouter(dependencies: CheckinCodeRouterDependencies): Router {
  const router = Router();
  const { requireAuth, geofenceAccuracyThresholdMeters, qrTokenTtlSeconds } = dependencies;

  const issueCode =
    (purpose: 'checkin' | 'checkout'): RequestHandler =>
    async (req, res, next) => {
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
      const caller = req.auth;
      if (!caller) {
        sendProblem(res, { type: 'about:blank', title: 'Unauthorized', status: 401 });
        return;
      }

      try {
        const [row] = await db
          .select({
            visit: schema.visitSchedules,
            dependant: {
              geofenceLat: schema.dependants.geofenceLat,
              geofenceLng: schema.dependants.geofenceLng,
              geofenceRadiusMeters: schema.dependants.geofenceRadiusMeters,
            },
            caregiverName: schema.users.fullName,
            // Flat, not a nested object: as a nested left-joined object, drizzle returned it as null
            // when the facilitator was null, hiding a set checkoutRequestedAt.
            facilitator: schema.verificationEvents.qrFamilyMemberUserId,
            checkoutRequestedAt: schema.verificationEvents.checkoutRequestedAt,
          })
          .from(schema.visitSchedules)
          .innerJoin(schema.dependants, eq(schema.dependants.id, schema.visitSchedules.dependantId))
          .innerJoin(schema.users, eq(schema.users.id, schema.visitSchedules.caregiverId))
          .leftJoin(
            schema.verificationEvents,
            eq(schema.verificationEvents.visitScheduleId, schema.visitSchedules.id),
          )
          .where(eq(schema.visitSchedules.id, visitScheduleId));
        if (!row) {
          sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
          return;
        }

        const link = await findFamilyMemberLink(db, row.visit.dependantId, caller.sub);
        if (!link) {
          sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
          return;
        }
        const facilitator = row.facilitator;
        if (purpose === 'checkout' && facilitator && facilitator !== link.callerRow.id) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
            detail: 'The family member who showed the check-in code confirms this check-out.',
          });
          return;
        }
        const awaiting =
          purpose === 'checkin'
            ? row.visit.status === 'scheduled'
            : row.visit.status === 'in_progress' && row.checkoutRequestedAt !== null;
        if (!awaiting) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            detail:
              purpose === 'checkin'
                ? `This visit is not awaiting check-in (current status: ${row.visit.status}).`
                : 'The caregiver has not asked to check out of this visit yet.',
          });
          return;
        }

        const { distanceMeters, failureReason } = assessPosition(
          body,
          row.dependant,
          geofenceAccuracyThresholdMeters,
        );
        const now = new Date();
        await db.insert(schema.verificationAttempts).values({
          id: uuidv7(),
          visitScheduleId,
          attemptType: 'family_location',
          passed: !failureReason,
          failureReason: failureReason ?? null,
          // Deliberately not the coordinates: see the header.
          metadata: {
            familyMemberUserId: link.callerRow.id,
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

        const { token, hash } = generateSessionToken();
        const digits =
          purpose === 'checkout' ? String(randomInt(0, 1_000_000)).padStart(6, '0') : undefined;
        const expiresAt = new Date(now.getTime() + qrTokenTtlSeconds * 1000);
        await db.transaction(async (tx) => {
          const [code] = await tx
            .insert(schema.checkinQrTokens)
            .values({
              visitScheduleId,
              familyMemberUserId: link.callerRow.id,
              tokenHash: hash,
              distanceFromGeofenceMeters: distanceMeters,
              issuedAt: now,
              expiresAt,
              purpose,
              codeHash: digits ? checkoutCodeHash(visitScheduleId, digits) : null,
            })
            .returning({ id: schema.checkinQrTokens.id });
          await recordAudit(tx, {
            actorUserId: link.callerRow.id,
            action: purpose === 'checkin' ? 'checkin_code.issue' : 'checkout_code.issue',
            entityType: 'visit_schedule',
            entityId: visitScheduleId,
            metadata: { codeId: code?.id, distanceMeters: Math.round(distanceMeters) },
          });
        });

        res.status(201).json({
          token,
          ...(digits ? { code: digits } : {}),
          expiresAt: expiresAt.toISOString(),
          caregiverDisplayName: row.caregiverName,
        });
      } catch (err) {
        next(err);
      }
    };

  router.post(
    '/:visitScheduleId/checkin/qr',
    requireAuth,
    requireRole('family_member'),
    issueCode('checkin'),
  );
  router.post(
    '/:visitScheduleId/checkout/qr',
    requireAuth,
    requireRole('family_member'),
    issueCode('checkout'),
  );

  return router;
}

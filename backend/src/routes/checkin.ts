// POST /visit-schedules/{visitScheduleId}/checkin/geofence (HEZ-33), plus HEZ-34's caregiver
// check-in photo endpoints. Mounted at the same `/visit-schedules` prefix as
// routes/visitSchedules.ts, but kept as its own router/file since the check-in flow is a
// materially different concern from HEZ-32's schedule CRUD - and, per openapi.yaml, authenticates
// its later steps with both the caller's Cognito ID token and the session token the geofence
// endpoint issues (see auth/checkinSession.ts's header for the dual-auth design reasoning).
//
// RBAC (confirmed with the user before implementing, not assumed): caregiver-only, and only for a
// visit they're the assigned caregiver on - no supervisor override. Matches architecture.md's
// design: the caregiver's identity comes from their own Cognito login, never a claim made at
// check-in.
//
// Precondition (confirmed with the user): the visit must currently be 'scheduled', rejected with
// 409 otherwise. Calling the geofence endpoint again while still 'scheduled' (e.g. retrying after a
// later step timed out) is allowed and simply re-issues a fresh session token - verification_events.
// session_token_hash is overwritten (upsert), not appended, so re-issuing one naturally invalidates
// whatever token came before it for this visit.
//
// Configurable thresholds (confirmed with the user; architecture.md itself flags these as
// "configurable... not yet finalized"): GEOFENCE_ACCURACY_THRESHOLD_METERS (20m) and
// CHECKIN_SESSION_TOKEN_TTL_SECONDS (600s), threaded in from config.ts rather than hardcoded here.
//
// **HEZ-34 revised 2026-09-19, same session as the original build**: the caregiver check-in step
// was originally a multi-frame challenge-response liveness check (a randomized on-camera prompt,
// DetectFaces across a captured frame burst, pose/eye movement checked against the specific issued
// challenge). The user explicitly decided to drop real liveness/anti-spoofing detection in favor of
// a single photo, for caregiver mobile app build simplicity - a deliberate, informed security
// tradeoff (a printed or displayed photo of the caregiver can no longer be distinguished from the
// caregiver actually being present), not an oversight. This applies to the not-yet-built dependant
// step (HEZ-35) too, for consistency. See docs/architecture.md's "Key design decisions" for the
// full record. The GET .../caregiver-liveness/challenge endpoint (and the pending-challenge columns
// it used) no longer exists - there is nothing to challenge or wait on between upload and submit.
//
// Every attempt (pass or fail, geofence or the caregiver check-in step) writes a
// verification_attempts row - openapi.yaml's own stated purpose for these endpoints - so the audit
// trail explains *why* a failure happened, not just that one did.

import { and, desc, eq } from 'drizzle-orm';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { resolveCheckinSession, SESSION_TOKEN_HEADER } from '../auth/checkinSession.js';
import { requireRole } from '../auth/middleware.js';
import { generateSessionToken } from '../auth/sessionToken.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import { frameKeyPrefix, type CheckinFrameStorage } from '../db/checkinFrameStorage.js';
import { type CheckinPhotoValidator } from '../db/checkinLiveness.js';
import type { Db } from '../db/client.js';
import type { FaceMatcher } from '../db/faceMatch.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { haversineDistanceMeters } from '../geo.js';
import { logger } from '../logger.js';
import { parseOrSendProblem } from '../validation.js';

export interface CheckinRouterDependencies {
  requireAuth: RequestHandler;
  geofenceAccuracyThresholdMeters: number;
  sessionTokenTtlSeconds: number;
  // HEZ-34's caregiver check-in upload-url/submit endpoints - all optional together (matching
  // routes/dependants.ts's faceCollection precedent: "existing callers/tests that don't touch X
  // don't need to construct one - simply skipped without it"), so tests that only exercise the
  // geofence endpoint need no changes. Registered as real routes only when every one of them is
  // present - see createCheckinRouter() below.
  livenessFramesBucketName?: string;
  biometricEnrollmentsBucketName?: string;
  livenessMatchThresholdPercent?: number;
  photoValidator?: CheckinPhotoValidator;
  faceMatcher?: FaceMatcher;
  frameStorage?: CheckinFrameStorage;
}

const geofenceCheckinRequestSchema = z.object({
  gpsLat: z.number().min(-90).max(90),
  gpsLng: z.number().min(-180).max(180),
  accuracyMeters: z.number().nonnegative(),
  isMockLocation: z.boolean(),
});

// Express 5's params type allows string | string[], so req.params.visitScheduleId isn't a plain
// string on its own - validated the same way any other input is, via parseOrSendProblem.
const visitScheduleIdParamSchema = z.string().uuid();

type GeofenceFailureReason = 'mock_location_detected' | 'insufficient_accuracy' | 'out_of_range';

function geofenceFailureDetail(reason: GeofenceFailureReason): string {
  switch (reason) {
    case 'mock_location_detected':
      return 'The device reported a mock/simulated location, which is never accepted.';
    case 'insufficient_accuracy':
      return 'The device-reported GPS accuracy is worse than this check-in requires.';
    case 'out_of_range':
      return "The device is outside the dependant's registered geofence.";
  }
}

const livenessUploadUrlRequestSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png']),
});

const livenessSubmissionRequestSchema = z.object({
  s3Key: z.string().min(1),
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

// Shared by every route past the geofence step (upload-url/submit, caregiver and, later, dependant):
// caller lookup, visit lookup + ownership + 'scheduled' precondition (identical to the geofence
// handler's own checks), then the check-in session token (auth/checkinSession.ts) - required IN
// ADDITION to Cognito auth, not instead of it. Sends the appropriate error response itself and
// returns undefined on any failure, the same "send the response, return a falsy sentinel" pattern
// this codebase already establishes.
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

  return { callerRow, visit, event };
}

export function createCheckinRouter(dependencies: CheckinRouterDependencies): Router {
  const router = Router();
  const {
    requireAuth,
    geofenceAccuracyThresholdMeters,
    sessionTokenTtlSeconds,
    livenessFramesBucketName,
    biometricEnrollmentsBucketName,
    livenessMatchThresholdPercent,
    photoValidator,
    faceMatcher,
    frameStorage,
  } = dependencies;
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
    const body = parseOrSendProblem(geofenceCheckinRequestSchema, req.body, res);
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
      if (visit.status !== 'scheduled') {
        sendProblem(res, {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: `This visit is not awaiting check-in (current status: ${visit.status}).`,
        });
        return;
      }

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

      const distanceMeters = haversineDistanceMeters(
        body.gpsLat,
        body.gpsLng,
        dependant.geofenceLat,
        dependant.geofenceLng,
      );

      let failureReason: GeofenceFailureReason | undefined;
      if (body.isMockLocation) {
        failureReason = 'mock_location_detected';
      } else if (body.accuracyMeters > geofenceAccuracyThresholdMeters) {
        failureReason = 'insufficient_accuracy';
      } else if (distanceMeters > dependant.geofenceRadiusMeters) {
        failureReason = 'out_of_range';
      }

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
          detail: geofenceFailureDetail(failureReason),
        });
        return;
      }

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
            // A fresh session token invalidates whatever check-in progress belonged to the token
            // being replaced - enforces "one continuous session for the whole check-in."
            caregiverLivenessPassed: null,
            dependantLivenessPassed: null,
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

  // HEZ-34's two caregiver check-in routes (upload-url, submit), registered together only when
  // every dependency they need is present (see CheckinRouterDependencies' comment above) - simply
  // absent otherwise, rather than registered and 503-ing per-request, since a missing AWS-client
  // dependency here is a startup wiring mistake, not a transient condition.
  if (
    livenessFramesBucketName &&
    biometricEnrollmentsBucketName &&
    livenessMatchThresholdPercent !== undefined &&
    photoValidator &&
    faceMatcher &&
    frameStorage
  ) {
    // POST .../caregiver-liveness/upload-url (HEZ-34): presigns the one check-in photo upload. Not
    // part of openapi.yaml's original draft (no endpoint existed anywhere for this), added here to
    // close that real contract gap, matching routes/biometricEnrollments.ts's upload-url/confirm
    // split.
    router.post(
      '/:visitScheduleId/checkin/caregiver-liveness/upload-url',
      async (req, res, next) => {
        const visitScheduleId = parseOrSendProblem(
          visitScheduleIdParamSchema,
          req.params.visitScheduleId,
          res,
        );
        if (!visitScheduleId) {
          return;
        }
        const body = parseOrSendProblem(livenessUploadUrlRequestSchema, req.body, res);
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

          const result = await frameStorage.createUploadUrl({
            visitScheduleId,
            subject: 'caregiver',
            contentType: body.contentType,
          });
          res.status(201).json({ ...result, expiresAt: result.expiresAt.toISOString() });
        } catch (err) {
          next(err);
        }
      },
    );

    // POST .../caregiver-liveness (HEZ-34): a single-face check on the uploaded photo
    // (db/checkinLiveness.ts) followed, on pass, by CompareFaces against the caregiver's enrolled
    // reference images (db/faceMatch.ts, Linear HEZ-36's deliverable - built here since this
    // endpoint's own openapi.yaml contract requires it, structured from the start to be reused
    // unchanged by HEZ-35's dependant step).
    router.post('/:visitScheduleId/checkin/caregiver-liveness', async (req, res, next) => {
      const visitScheduleId = parseOrSendProblem(
        visitScheduleIdParamSchema,
        req.params.visitScheduleId,
        res,
      );
      if (!visitScheduleId) {
        return;
      }
      const body = parseOrSendProblem(livenessSubmissionRequestSchema, req.body, res);
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
        const { visit } = context;

        const expectedPrefix = frameKeyPrefix(visitScheduleId, 'caregiver');
        if (!body.s3Key.startsWith(expectedPrefix)) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: `s3Key must belong to this visit's caregiver check-in upload (expected prefix "${expectedPrefix}").`,
          });
          return;
        }
        const exists = await frameStorage.objectExists(body.s3Key);
        if (!exists) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: `No object was found at ${body.s3Key} - upload it via the presigned URL first.`,
          });
          return;
        }

        const cleanupPhoto = async (): Promise<void> => {
          try {
            await frameStorage.deleteObjects([body.s3Key]);
          } catch (err) {
            logger.warn(
              { err, visitScheduleId },
              'Failed to delete check-in photo after processing',
            );
          }
        };

        const now = new Date();

        const recordFailedAttempt = async (
          failureReason: string,
          metadata: Record<string, unknown>,
        ): Promise<void> => {
          await db.insert(schema.verificationAttempts).values({
            id: uuidv7(),
            visitScheduleId,
            attemptType: 'caregiver_liveness',
            passed: false,
            failureReason,
            metadata,
            attemptedAt: now,
          });
        };

        const recordPassedAttempt = async (
          matchConfidence: number,
          metadata: Record<string, unknown>,
        ): Promise<void> => {
          await db.transaction(async (tx) => {
            await tx.insert(schema.verificationAttempts).values({
              id: uuidv7(),
              visitScheduleId,
              attemptType: 'caregiver_liveness',
              passed: true,
              failureReason: null,
              metadata,
              attemptedAt: now,
            });
            await tx
              .update(schema.verificationEvents)
              .set({
                caregiverLivenessPassed: true,
                caregiverMatchConfidence: matchConfidence.toFixed(2),
              })
              .where(eq(schema.verificationEvents.visitScheduleId, visitScheduleId));
          });
        };

        const photoCheck = await photoValidator.validatePhoto({
          bucketName: livenessFramesBucketName,
          s3Key: body.s3Key,
        });

        if (!photoCheck.ok) {
          await recordFailedAttempt(photoCheck.reason, { s3Key: body.s3Key });
          await cleanupPhoto();
          res
            .status(200)
            .json({ passed: false, matchConfidence: null, failureReason: photoCheck.reason });
          return;
        }

        const candidates = await db
          .select({ s3Key: schema.biometricEnrollments.s3Key })
          .from(schema.biometricEnrollments)
          .where(
            and(
              eq(schema.biometricEnrollments.subjectType, 'caregiver'),
              eq(schema.biometricEnrollments.caregiverId, visit.caregiverId),
              eq(schema.biometricEnrollments.status, 'active'),
            ),
          )
          .orderBy(desc(schema.biometricEnrollments.qualityScore));

        if (candidates.length === 0) {
          await recordFailedAttempt('not_enrolled', { s3Key: body.s3Key });
          await cleanupPhoto();
          res
            .status(200)
            .json({ passed: false, matchConfidence: null, failureReason: 'not_enrolled' });
          return;
        }

        const matchResult = await faceMatcher.compareAgainstCandidates({
          sourceBucket: livenessFramesBucketName,
          sourceS3Key: body.s3Key,
          candidates: candidates.map((candidate) => ({
            bucket: biometricEnrollmentsBucketName,
            s3Key: candidate.s3Key,
          })),
          matchThresholdPercent: livenessMatchThresholdPercent,
        });

        await cleanupPhoto();

        if (matchResult.matched) {
          await recordPassedAttempt(matchResult.similarity, {
            matchConfidence: matchResult.similarity,
          });
          res
            .status(200)
            .json({ passed: true, matchConfidence: matchResult.similarity, failureReason: null });
          return;
        }

        await recordFailedAttempt('identity_mismatch', {
          bestSimilarity: matchResult.bestSimilarity,
        });
        res.status(200).json({
          passed: false,
          matchConfidence: matchResult.bestSimilarity,
          failureReason: 'identity_mismatch',
        });
      } catch (err) {
        next(err);
      }
    });
  }

  return router;
}

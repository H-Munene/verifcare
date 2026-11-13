// Voice enrolment (2026-11-13): about 30 seconds of a person's speech becomes the voiceprint their
// visit recordings are checked against. A caregiver enrols themselves in the caregiver app; a family
// member linked to a dependant enrols the dependant in the family app, at home.
//
// The audio goes to S3 through a presigned URL, the voice Lambda makes the voiceprint and deletes
// the audio, and the voiceprint stays in a bucket only that Lambda can read. Re-enrolling replaces
// the voiceprint. Supervisors can see who is enrolled and when, never the voiceprint.

import { eq } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { requireRole } from '../auth/middleware.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import { subjectsWithActiveConsent, type ConsentSubject } from '../db/consents.js';
import * as schema from '../db/schema.js';
import { enrolmentAudioKeyPrefix, type VisitAudioStorage } from '../db/visitAudioStorage.js';
import { sendProblem } from '../errors.js';
import { logger } from '../logger.js';
import { parseOrSendProblem } from '../validation.js';
import { activeEnrollment, newVoiceprintKey } from '../voiceChecks.js';
import type { VoiceService } from '../voiceService.js';
import { findFamilyMemberLink } from './dependants.js';

export interface VoiceEnrollmentsRouterDependencies {
  requireAuth: RequestHandler;
  storage: VisitAudioStorage;
  voice: VoiceService;
}

const MAX_ENROLMENT_BYTES = 5 * 1024 * 1024;
const idParamSchema = z.string().uuid();
const confirmRequestSchema = z.object({ s3Key: z.string().min(1).max(300) });

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

function enrolmentView(row: typeof schema.voiceEnrollments.$inferSelect | undefined) {
  return row
    ? { enrolled: true, enrolledAt: row.enrolledAt.toISOString(), speechSeconds: row.speechSeconds }
    : { enrolled: false, enrolledAt: null, speechSeconds: null };
}

export function createVoiceEnrollmentsRouter(
  dependencies: VoiceEnrollmentsRouterDependencies,
): Router {
  const router = Router();
  const { requireAuth, storage, voice } = dependencies;
  router.use(requireAuth);

  // The caller's own caregiver subject, or the dependant they're linked to. Sends the error and
  // returns undefined when they may not enrol this person.
  async function resolveEnroller(
    db: Db,
    req: Parameters<RequestHandler>[0],
    res: Response,
    dependantIdParam: string | undefined,
  ): Promise<{ subject: ConsentSubject; userId: string } | undefined> {
    if (dependantIdParam === undefined) {
      const caller = await getUserByCognitoSub(db, req.auth!.sub);
      const [caregiver] = caller
        ? await db
            .select({ id: schema.caregivers.userId })
            .from(schema.caregivers)
            .where(eq(schema.caregivers.userId, caller.id))
        : [];
      if (!caller || !caregiver) {
        sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
        return undefined;
      }
      return { subject: { subjectType: 'caregiver', id: caregiver.id }, userId: caller.id };
    }
    const dependantId = parseOrSendProblem(idParamSchema, dependantIdParam, res);
    if (!dependantId) {
      return undefined;
    }
    const link = await findFamilyMemberLink(db, dependantId, req.auth!.sub);
    if (!link) {
      sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
      return undefined;
    }
    return { subject: { subjectType: 'dependant', id: dependantId }, userId: link.callerRow.id };
  }

  async function requireVoiceConsent(db: Db, subject: ConsentSubject, res: Response) {
    const consented = await subjectsWithActiveConsent(db, [subject], 'voice_verification');
    if (!consented.has(subject.id)) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Voice verification has not been consented to for this person.',
      });
      return false;
    }
    return true;
  }

  const uploadUrl =
    (dependantRoute: boolean): RequestHandler =>
    async (req, res, next) => {
      const db = getDb(res);
      if (!db) {
        return;
      }
      try {
        const enroller = await resolveEnroller(
          db,
          req,
          res,
          dependantRoute ? String(req.params.dependantId) : undefined,
        );
        if (!enroller || !(await requireVoiceConsent(db, enroller.subject, res))) {
          return;
        }
        const created = await storage.createUploadUrl(enrolmentAudioKeyPrefix(enroller.subject));
        res.status(201).json({ ...created, expiresAt: created.expiresAt.toISOString() });
      } catch (err) {
        next(err);
      }
    };

  const confirm =
    (dependantRoute: boolean): RequestHandler =>
    async (req, res, next) => {
      const body = parseOrSendProblem(confirmRequestSchema, req.body, res);
      const db = body && getDb(res);
      if (!body || !db) {
        return;
      }
      try {
        const enroller = await resolveEnroller(
          db,
          req,
          res,
          dependantRoute ? String(req.params.dependantId) : undefined,
        );
        if (!enroller || !(await requireVoiceConsent(db, enroller.subject, res))) {
          return;
        }
        const { subject, userId } = enroller;
        if (!body.s3Key.startsWith(enrolmentAudioKeyPrefix(subject))) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: "s3Key doesn't belong to this person's enrolment upload.",
          });
          return;
        }
        const size = await storage.objectSize(body.s3Key);
        if (size === null || size === 0 || size > MAX_ENROLMENT_BYTES) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            detail: 'No usable enrolment recording was uploaded.',
          });
          return;
        }
        const voiceprintKey = newVoiceprintKey(subject);
        const made = await voice
          .enrol({ audioKey: body.s3Key, voiceprintKey })
          .catch(async (err: unknown) => {
            // A timed-out call may still finish in the voice Lambda and leave a voiceprint no row
            // points to, so ask for it to be deleted too.
            // ponytail: best effort, it can lose the race with a still-running enrol; a sweep of
            // unreferenced keys in the voiceprint bucket is the upgrade.
            await voice.remove({ voiceprintKey }).catch(() => {});
            throw err;
          });
        if (!made.enrolled) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            detail: `Only ${Math.round(made.speechSeconds)} seconds of speech were heard. Record again, speaking for about 30 seconds.`,
          });
          return;
        }
        const replaced = await db.transaction(async (tx) => {
          const previous = await activeEnrollment(tx, subject);
          if (previous) {
            await tx
              .update(schema.voiceEnrollments)
              .set({ removedAt: new Date() })
              .where(eq(schema.voiceEnrollments.id, previous.id));
          }
          const [row] = await tx
            .insert(schema.voiceEnrollments)
            .values({
              subjectType: subject.subjectType,
              caregiverId: subject.subjectType === 'caregiver' ? subject.id : null,
              dependantId: subject.subjectType === 'dependant' ? subject.id : null,
              voiceprintKey: voiceprintKey,
              speechSeconds: made.speechSeconds,
              modelRevision: made.modelRevision,
              enrolledBy: userId,
            })
            .returning();
          await recordAudit(tx, {
            actorUserId: userId,
            action: previous ? 'voice_enrollment.replace' : 'voice_enrollment.create',
            entityType: subject.subjectType,
            entityId: subject.id,
            metadata: { speechSeconds: made.speechSeconds },
          });
          return { previous, row: row! };
        });
        if (replaced.previous) {
          // After the commit, so a failed delete leaves an orphan object rather than a lost enrolment.
          await voice
            .remove({ voiceprintKey: replaced.previous.voiceprintKey })
            .catch((err: unknown) => logger.warn({ err }, 'old voiceprint not deleted'));
        }
        res.status(201).json(enrolmentView(replaced.row));
      } catch (err) {
        next(err);
      }
    };

  // The caregiver's own enrolment.
  router.get('/me', requireRole('caregiver'), async (req, res, next) => {
    const db = getDb(res);
    if (!db) {
      return;
    }
    try {
      const enroller = await resolveEnroller(db, req, res, undefined);
      if (enroller) {
        res.status(200).json(enrolmentView(await activeEnrollment(db, enroller.subject)));
      }
    } catch (err) {
      next(err);
    }
  });
  router.post('/me/upload-url', requireRole('caregiver'), uploadUrl(false));
  router.post('/me', requireRole('caregiver'), confirm(false));

  // A dependant's enrolment, by a linked family member.
  router.post('/dependants/:dependantId/upload-url', requireRole('family_member'), uploadUrl(true));
  router.post('/dependants/:dependantId', requireRole('family_member'), confirm(true));

  // Enrolment status: linked family members for a dependant, supervisors for anyone.
  router.get(
    '/dependants/:dependantId',
    requireRole('family_member', 'supervisor'),
    async (req, res, next) => {
      const dependantId = parseOrSendProblem(idParamSchema, req.params.dependantId, res);
      const db = dependantId && getDb(res);
      if (!dependantId || !db) {
        return;
      }
      try {
        if (
          req.auth!.role === 'family_member' &&
          !(await findFamilyMemberLink(db, dependantId, req.auth!.sub))
        ) {
          sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
          return;
        }
        res
          .status(200)
          .json(
            enrolmentView(
              await activeEnrollment(db, { subjectType: 'dependant', id: dependantId }),
            ),
          );
      } catch (err) {
        next(err);
      }
    },
  );
  router.get('/caregivers/:caregiverId', requireRole('supervisor'), async (req, res, next) => {
    const caregiverId = parseOrSendProblem(idParamSchema, req.params.caregiverId, res);
    const db = caregiverId && getDb(res);
    if (!caregiverId || !db) {
      return;
    }
    try {
      res
        .status(200)
        .json(
          enrolmentView(await activeEnrollment(db, { subjectType: 'caregiver', id: caregiverId })),
        );
    } catch (err) {
      next(err);
    }
  });

  return router;
}

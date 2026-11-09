// Visit audio (2026-11-09): the caregiver records up to 30 seconds during the visit, and the
// dependant's linked family members can listen to it as added assurance that the visit happened.
//
// Who can listen is deliberately narrow: family members linked to this dependant, and nobody else.
// Supervisors only ever see that a recording exists or why there isn't one (user decision). Each
// playback URL issued is audit-logged, since a recording made in someone's home is sensitive
// whatever it's used for.
//
// No model processes this audio. The acoustic model's results are reported separately and it does
// not run in this system.
//
// Mounted before routes/checkin.ts, whose router-wide requireRole('caregiver') would otherwise
// reject family members.

import { and, eq } from 'drizzle-orm';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { requireRole } from '../auth/middleware.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import { subjectsWithActiveConsent } from '../db/consents.js';
import * as schema from '../db/schema.js';
import { visitAudioKeyPrefix, type VisitAudioStorage } from '../db/visitAudioStorage.js';
import { sendProblem } from '../errors.js';
import { parseOrSendProblem } from '../validation.js';
import { findFamilyMemberLink } from './dependants.js';

export interface VisitAudioRouterDependencies {
  requireAuth: RequestHandler;
  storage: VisitAudioStorage;
  now?: () => Date;
}

// Mirrors infra/lib/storage.ts's lifecycle rule, which is what actually deletes the object.
export const AUDIO_RETENTION_DAYS = 90;
const MIN_DURATION_SECONDS = 5;
// One over the 30-second limit, since a recording stopped at 30 s can encode a fraction longer.
const MAX_DURATION_SECONDS = 31;
// 30 seconds of AAC is well under 1 MB. A presigned PUT can't enforce a size, so it's checked here.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

const visitScheduleIdParamSchema = z.string().uuid();
const confirmRequestSchema = z.object({
  s3Key: z.string().min(1).max(300),
  durationSeconds: z.number().int().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS),
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

async function dependantConsentsToAudio(db: Db, dependantId: string): Promise<boolean> {
  const consented = await subjectsWithActiveConsent(
    db,
    [{ subjectType: 'dependant', id: dependantId }],
    'visit_audio',
  );
  return consented.has(dependantId);
}

async function findRecording(db: Db, visitScheduleId: string) {
  const [recording] = await db
    .select()
    .from(schema.audioRecords)
    .where(eq(schema.audioRecords.verificationEventId, visitScheduleId));
  return recording;
}

export function createVisitAudioRouter(dependencies: VisitAudioRouterDependencies): Router {
  const router = Router();
  const { requireAuth, storage } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  // The assigned caregiver's own visit. With `inProgressOnly`, also requires that it's under way.
  // Sends the error itself and returns undefined on failure.
  async function resolveCaregiverVisit(
    db: Db,
    visitScheduleId: string,
    callerSub: string,
    res: Response,
    inProgressOnly: boolean,
  ) {
    const callerRow = await getUserByCognitoSub(db, callerSub);
    const [visit] = await db
      .select()
      .from(schema.visitSchedules)
      .where(eq(schema.visitSchedules.id, visitScheduleId));
    if (!visit) {
      sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
      return undefined;
    }
    if (!callerRow || visit.caregiverId !== callerRow.id) {
      sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
      return undefined;
    }
    if (inProgressOnly && visit.status !== 'in_progress') {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `A recording can only be added during a visit (current status: ${visit.status}).`,
      });
      return undefined;
    }
    return { visit, callerRow };
  }

  function sendNoConsent(res: Response): void {
    sendProblem(res, {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: "This dependant's family has not consented to audio being recorded at visits.",
    });
  }

  // GET .../audio/requirement: lets the caregiver app decide whether to show the recorder.
  router.get(
    '/:visitScheduleId/audio/requirement',
    requireAuth,
    requireRole('caregiver'),
    async (req, res, next) => {
      const visitScheduleId = parseOrSendProblem(
        visitScheduleIdParamSchema,
        req.params.visitScheduleId,
        res,
      );
      const db = visitScheduleId && getDb(res);
      if (!visitScheduleId || !db || !req.auth) {
        return;
      }
      try {
        const context = await resolveCaregiverVisit(db, visitScheduleId, req.auth.sub, res, false);
        if (!context) {
          return;
        }
        res.status(200).json({
          required: await dependantConsentsToAudio(db, context.visit.dependantId),
          recorded: (await findRecording(db, visitScheduleId)) !== undefined,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:visitScheduleId/audio/upload-url',
    requireAuth,
    requireRole('caregiver'),
    async (req, res, next) => {
      const visitScheduleId = parseOrSendProblem(
        visitScheduleIdParamSchema,
        req.params.visitScheduleId,
        res,
      );
      const db = visitScheduleId && getDb(res);
      if (!visitScheduleId || !db || !req.auth) {
        return;
      }
      try {
        const context = await resolveCaregiverVisit(db, visitScheduleId, req.auth.sub, res, true);
        if (!context) {
          return;
        }
        if (!(await dependantConsentsToAudio(db, context.visit.dependantId))) {
          sendNoConsent(res);
          return;
        }
        const created = await storage.createUploadUrl(visitScheduleId);
        res.status(201).json({ ...created, expiresAt: created.expiresAt.toISOString() });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:visitScheduleId/audio',
    requireAuth,
    requireRole('caregiver'),
    async (req, res, next) => {
      const visitScheduleId = parseOrSendProblem(
        visitScheduleIdParamSchema,
        req.params.visitScheduleId,
        res,
      );
      if (!visitScheduleId) {
        return;
      }
      const body = parseOrSendProblem(confirmRequestSchema, req.body, res);
      const db = body && getDb(res);
      if (!body || !db || !req.auth) {
        return;
      }
      try {
        const context = await resolveCaregiverVisit(db, visitScheduleId, req.auth.sub, res, true);
        if (!context) {
          return;
        }
        if (!(await dependantConsentsToAudio(db, context.visit.dependantId))) {
          sendNoConsent(res);
          return;
        }
        if (!body.s3Key.startsWith(visitAudioKeyPrefix(visitScheduleId))) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: "s3Key doesn't belong to this visit's recording upload.",
          });
          return;
        }
        const size = await storage.objectSize(body.s3Key);
        if (size === null) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: 'No uploaded recording was found. Upload it through the presigned URL first.',
          });
          return;
        }
        if (size === 0 || size > MAX_AUDIO_BYTES) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            detail: 'The uploaded recording is empty or too large for a 30-second recording.',
          });
          return;
        }

        const at = now();
        // Upsert: a caregiver retrying after a dropped response must not hit a conflict.
        await db.transaction(async (tx) => {
          await tx
            .insert(schema.audioRecords)
            .values({
              verificationEventId: visitScheduleId,
              s3Key: body.s3Key,
              durationSeconds: body.durationSeconds,
              uploadedAt: at,
            })
            .onConflictDoUpdate({
              target: schema.audioRecords.verificationEventId,
              set: { s3Key: body.s3Key, durationSeconds: body.durationSeconds, uploadedAt: at },
            });
          await recordAudit(tx, {
            actorUserId: context.callerRow.id,
            action: 'visit_audio.upload',
            entityType: 'visit_schedule',
            entityId: visitScheduleId,
            metadata: { durationSeconds: body.durationSeconds },
          });
        });
        res
          .status(201)
          .json({ durationSeconds: body.durationSeconds, uploadedAt: at.toISOString() });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET .../audio: a short-lived playback URL, for family members linked to this dependant only.
  router.get(
    '/:visitScheduleId/audio',
    requireAuth,
    requireRole('family_member'),
    async (req, res, next) => {
      const visitScheduleId = parseOrSendProblem(
        visitScheduleIdParamSchema,
        req.params.visitScheduleId,
        res,
      );
      const db = visitScheduleId && getDb(res);
      if (!visitScheduleId || !db || !req.auth) {
        return;
      }
      try {
        const [visit] = await db
          .select({ dependantId: schema.visitSchedules.dependantId })
          .from(schema.visitSchedules)
          .where(and(eq(schema.visitSchedules.id, visitScheduleId)));
        if (!visit) {
          sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
          return;
        }
        const link = await findFamilyMemberLink(db, visit.dependantId, req.auth.sub);
        if (!link) {
          sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
          return;
        }
        const recording = await findRecording(db, visitScheduleId);
        if (!recording) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            detail: 'There is no recording for this visit.',
          });
          return;
        }
        const at = now();
        const expiresOn = recording.uploadedAt.getTime() + AUDIO_RETENTION_DAYS * 86_400_000;
        if (at.getTime() >= expiresOn) {
          sendProblem(res, {
            type: 'about:blank',
            title: 'Gone',
            status: 410,
            detail: `Recordings are deleted after ${AUDIO_RETENTION_DAYS} days.`,
          });
          return;
        }

        const playback = await storage.createPlaybackUrl(recording.s3Key);
        await recordAudit(db, {
          actorUserId: link.callerRow.id,
          action: 'visit_audio.listen',
          entityType: 'visit_schedule',
          entityId: visitScheduleId,
        });
        res.status(200).json({
          url: playback.url,
          expiresAt: playback.expiresAt.toISOString(),
          durationSeconds: recording.durationSeconds,
          uploadedAt: recording.uploadedAt.toISOString(),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

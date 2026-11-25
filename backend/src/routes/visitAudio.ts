// Visit recordings (2026-11-09): since 2026-11-24 one per visit, of the dependant, made at
// check-out and at least 10 seconds long (2026-11-13 to 11-23 the caregiver was recorded too). It's
// a check-out requirement, though it can be replaced by a stated reason, since a dependant is never
// made to speak.
//
// The recording is checked against the dependant's voiceprint (voiceChecks.ts), and the result is
// returned so the caregiver sees it at once. It's advisory: a failed check can be recorded again,
// but never blocks check-out.
//
// Who can listen is deliberately narrow: family members linked to this dependant, to the dependant's
// recording only. Each playback URL issued is audit-logged, since a recording made in someone's
// home is sensitive whatever it's used for.
//
// A recording of a person needs their visit_audio consent; it's analysed only with their
// voice_verification consent and an enrolment.
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
import { subjectsWithActiveConsent, type ConsentSubject } from '../db/consents.js';
import * as schema from '../db/schema.js';
import { visitAudioKeyPrefix, type VisitAudioStorage } from '../db/visitAudioStorage.js';
import { sendProblem } from '../errors.js';
import { parseOrSendProblem } from '../validation.js';
import { checkRecording } from '../voiceChecks.js';
import type { VoiceService } from '../voiceService.js';
import { findFamilyMemberLink } from './dependants.js';

export interface VisitAudioRouterDependencies {
  requireAuth: RequestHandler;
  storage: VisitAudioStorage;
  voice: VoiceService;
  now?: () => Date;
}

// Mirrors infra/lib/storage.ts's lifecycle rule, which is what actually deletes the object.
export const AUDIO_RETENTION_DAYS = 90;
const MIN_RECORDING_SECONDS = 10;
// One over the 30-second limit, since a recording stopped at 30 s can encode a fraction longer.
const MAX_DURATION_SECONDS = 31;
// 30 seconds of AAC is well under 1 MB. A presigned PUT can't enforce a size, so it's checked here.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

const visitScheduleIdParamSchema = z.string().uuid();
const roleParamSchema = z.enum(schema.VISIT_RECORDING_ROLES);
const confirmRequestSchema = z.object({
  s3Key: z.string().min(1).max(300),
  durationSeconds: z.number().int().min(MIN_RECORDING_SECONDS).max(MAX_DURATION_SECONDS),
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

/** Who a recording of `role` at this visit is of. */
export function recordingSubject(
  visit: { caregiverId: string; dependantId: string },
  role: schema.RecordingRole,
): ConsentSubject {
  return role === 'caregiver'
    ? { subjectType: 'caregiver', id: visit.caregiverId }
    : { subjectType: 'dependant', id: visit.dependantId };
}

/** For each role, whether a recording is required (the person consents to it) and whether one exists. */
export async function recordingRequirements(
  db: Db,
  visit: { id: string; caregiverId: string; dependantId: string },
) {
  const subjects = schema.VISIT_RECORDING_ROLES.map((role) => recordingSubject(visit, role));
  const consented = await subjectsWithActiveConsent(db, subjects, 'visit_audio');
  const recorded = await db
    .select({ role: schema.audioRecords.role })
    .from(schema.audioRecords)
    .where(eq(schema.audioRecords.verificationEventId, visit.id));
  const has = new Set(recorded.map((row) => row.role));
  return Object.fromEntries(
    schema.VISIT_RECORDING_ROLES.map((role, i) => [
      role,
      { required: consented.has(subjects[i]!.id), recorded: has.has(role) },
    ]),
  ) as Record<schema.VisitRecordingRole, { required: boolean; recorded: boolean }>;
}

async function findRecording(db: Db, visitScheduleId: string, role: schema.RecordingRole) {
  const [recording] = await db
    .select()
    .from(schema.audioRecords)
    .where(
      and(
        eq(schema.audioRecords.verificationEventId, visitScheduleId),
        eq(schema.audioRecords.role, role),
      ),
    );
  return recording;
}

export function createVisitAudioRouter(dependencies: VisitAudioRouterDependencies): Router {
  const router = Router();
  const { requireAuth, storage, voice } = dependencies;
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

  // Sends the error itself and returns false when this person hasn't consented to being recorded.
  async function requireRecordingConsent(
    db: Db,
    subject: ConsentSubject,
    res: Response,
  ): Promise<boolean> {
    const consented = await subjectsWithActiveConsent(db, [subject], 'visit_audio');
    if (!consented.has(subject.id)) {
      sendProblem(res, {
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail:
          subject.subjectType === 'caregiver'
            ? 'You have not consented to being recorded at visits.'
            : "This dependant's family has not consented to audio being recorded at visits.",
      });
      return false;
    }
    return true;
  }

  // GET .../audio/requirement: which recordings the caregiver app should ask for.
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
        res.status(200).json(await recordingRequirements(db, context.visit));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:visitScheduleId/audio/:role/upload-url',
    requireAuth,
    requireRole('caregiver'),
    async (req, res, next) => {
      const visitScheduleId = parseOrSendProblem(
        visitScheduleIdParamSchema,
        req.params.visitScheduleId,
        res,
      );
      const role = visitScheduleId && parseOrSendProblem(roleParamSchema, req.params.role, res);
      const db = role && getDb(res);
      if (!visitScheduleId || !role || !db || !req.auth) {
        return;
      }
      try {
        const context = await resolveCaregiverVisit(db, visitScheduleId, req.auth.sub, res, true);
        if (
          !context ||
          !(await requireRecordingConsent(db, recordingSubject(context.visit, role), res))
        ) {
          return;
        }
        const created = await storage.createUploadUrl(visitAudioKeyPrefix(visitScheduleId, role));
        res.status(201).json({ ...created, expiresAt: created.expiresAt.toISOString() });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:visitScheduleId/audio/:role',
    requireAuth,
    requireRole('caregiver'),
    async (req, res, next) => {
      const visitScheduleId = parseOrSendProblem(
        visitScheduleIdParamSchema,
        req.params.visitScheduleId,
        res,
      );
      const role = visitScheduleId && parseOrSendProblem(roleParamSchema, req.params.role, res);
      const body = role && parseOrSendProblem(confirmRequestSchema, req.body, res);
      const db = body && getDb(res);
      if (!visitScheduleId || !role || !body || !db || !req.auth) {
        return;
      }
      try {
        const context = await resolveCaregiverVisit(db, visitScheduleId, req.auth.sub, res, true);
        const subject = context && recordingSubject(context.visit, role);
        if (!context || !subject || !(await requireRecordingConsent(db, subject, res))) {
          return;
        }
        if (!body.s3Key.startsWith(visitAudioKeyPrefix(visitScheduleId, role))) {
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
        // Upsert: a caregiver retrying after a dropped response, or re-recording, must not conflict.
        const recording = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(schema.audioRecords)
            .values({
              verificationEventId: visitScheduleId,
              role,
              s3Key: body.s3Key,
              durationSeconds: body.durationSeconds,
              uploadedAt: at,
            })
            .onConflictDoUpdate({
              target: [schema.audioRecords.verificationEventId, schema.audioRecords.role],
              set: { s3Key: body.s3Key, durationSeconds: body.durationSeconds, uploadedAt: at },
            })
            .returning();
          await recordAudit(tx, {
            actorUserId: context.callerRow.id,
            action: 'visit_audio.upload',
            entityType: 'visit_schedule',
            entityId: visitScheduleId,
            metadata: { role, durationSeconds: body.durationSeconds },
          });
          return row!;
        });
        // After the recording is saved, so a slow or failing check can never lose it.
        const voiceCheck = await checkRecording(db, voice, recording, subject);
        res.status(201).json({
          role,
          durationSeconds: body.durationSeconds,
          uploadedAt: at.toISOString(),
          voiceCheck,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET .../audio: a short-lived playback URL for the dependant's recording, for family members
  // linked to this dependant only.
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
          .where(eq(schema.visitSchedules.id, visitScheduleId));
        if (!visit) {
          sendProblem(res, { type: 'about:blank', title: 'Not Found', status: 404 });
          return;
        }
        const link = await findFamilyMemberLink(db, visit.dependantId, req.auth.sub);
        if (!link) {
          sendProblem(res, { type: 'about:blank', title: 'Forbidden', status: 403 });
          return;
        }
        const recording = await findRecording(db, visitScheduleId, 'dependant');
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

// GET /voice-checks?dependantId= (2026-11-13): a dependant's voice check results across their
// recent visits, for the web console's Voice checks tab. Supervisors only. The results are
// advisory, and reading them is audit-logged, since they come from biometric data. (Until
// 2026-11-24 caregivers were recorded and checked too, with ?caregiverId=.)

import { and, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { requireRole } from '../auth/middleware.js';
import { getUserByCognitoSub } from '../db/callerLookup.js';
import type { Db } from '../db/client.js';
import type { ConsentSubject } from '../db/consents.js';
import * as schema from '../db/schema.js';
import { sendProblem } from '../errors.js';
import { parseOrSendProblem } from '../validation.js';
import { activeEnrollment } from '../voiceChecks.js';

export interface VoiceChecksRouterDependencies {
  requireAuth: RequestHandler;
}

const LIMIT = 50;

const querySchema = z.object({ dependantId: z.string().uuid() }).strict();

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

export function createVoiceChecksRouter(dependencies: VoiceChecksRouterDependencies): Router {
  const router = Router();
  router.use(dependencies.requireAuth, requireRole('supervisor'));

  router.get('/', async (req, res, next) => {
    const query = parseOrSendProblem(querySchema, req.query, res);
    const db = query && getDb(res);
    if (!query || !db) {
      return;
    }
    const subject: ConsentSubject = { subjectType: 'dependant', id: query.dependantId };
    try {
      const caregiverUser = alias(schema.users, 'caregiver_user');
      const rows = await db
        .select({
          visitScheduleId: schema.visitSchedules.id,
          scheduledStart: schema.visitSchedules.scheduledStart,
          caregiverName: caregiverUser.fullName,
          dependantName: schema.dependants.fullName,
          recordedAt: schema.audioRecords.uploadedAt,
          durationSeconds: schema.audioRecords.durationSeconds,
          result: schema.voiceChecks.result,
          score: schema.voiceChecks.score,
          speechSeconds: schema.voiceChecks.speechSeconds,
          threshold: schema.voiceChecks.threshold,
        })
        .from(schema.audioRecords)
        .innerJoin(
          schema.visitSchedules,
          eq(schema.visitSchedules.id, schema.audioRecords.verificationEventId),
        )
        .innerJoin(caregiverUser, eq(caregiverUser.id, schema.visitSchedules.caregiverId))
        .innerJoin(schema.dependants, eq(schema.dependants.id, schema.visitSchedules.dependantId))
        .leftJoin(schema.voiceChecks, eq(schema.voiceChecks.audioRecordId, schema.audioRecords.id))
        // The dependant's own recordings only, not a caregiver's from before 2026-11-24.
        .where(
          and(
            eq(schema.audioRecords.role, 'dependant'),
            eq(schema.visitSchedules.dependantId, subject.id),
          ),
        )
        .orderBy(desc(schema.visitSchedules.scheduledStart))
        .limit(LIMIT);

      const enrollment = await activeEnrollment(db, subject);
      const actor = await getUserByCognitoSub(db, req.auth!.sub);
      await recordAudit(db, {
        actorUserId: actor?.id ?? null,
        action: 'voice_checks.view',
        entityType: subject.subjectType,
        entityId: subject.id,
      });
      res.status(200).json({
        enrolment: enrollment
          ? { enrolled: true, enrolledAt: enrollment.enrolledAt.toISOString() }
          : { enrolled: false, enrolledAt: null },
        items: rows,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// Checking a visit recording against the voiceprint of the person it claims to be (2026-11-13).
// Advisory only: whatever happens, a result is stored and the caller carries on. A person is
// analysed only with active voice_verification consent and an active enrolment.

import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from './db/client.js';
import { subjectsWithActiveConsent, type ConsentSubject } from './db/consents.js';
import * as schema from './db/schema.js';
import { logger } from './logger.js';
import type { VoiceService } from './voiceService.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A new, unguessable voiceprint key for one person in the voiceprint bucket. */
export function newVoiceprintKey(subject: ConsentSubject): string {
  return `${subject.subjectType}/${subject.id}/${uuidv7()}.npy`;
}

export async function activeEnrollment(db: Db | Tx, subject: ConsentSubject) {
  const column =
    subject.subjectType === 'caregiver'
      ? schema.voiceEnrollments.caregiverId
      : schema.voiceEnrollments.dependantId;
  const [row] = await db
    .select()
    .from(schema.voiceEnrollments)
    .where(and(eq(column, subject.id), isNull(schema.voiceEnrollments.removedAt)));
  return row;
}

/**
 * Ends a person's enrolment and deletes their voiceprint, when they're deactivated (terms v4
 * promises it). The row is marked first, so a failed delete leaves an orphan object, logged, rather
 * than a voiceprint still in use.
 */
export async function removeEnrollment(
  db: Db,
  voice: VoiceService,
  subject: ConsentSubject,
): Promise<void> {
  const current = await activeEnrollment(db, subject);
  if (!current) {
    return;
  }
  await db
    .update(schema.voiceEnrollments)
    .set({ removedAt: new Date() })
    .where(eq(schema.voiceEnrollments.id, current.id));
  await voice
    .remove({ voiceprintKey: current.voiceprintKey })
    .catch((err: unknown) =>
      logger.warn({ err, enrollmentId: current.id }, 'voiceprint not deleted'),
    );
}

/** What a check found, as stored; `score` and `threshold` are null when nothing was compared. */
export interface VoiceCheckOutcome {
  result: schema.VoiceCheckResult;
  score: number | null;
  threshold: number | null;
}

export async function checkRecording(
  db: Db,
  voice: VoiceService,
  recording: { id: string; s3Key: string },
  subject: ConsentSubject,
): Promise<VoiceCheckOutcome> {
  let values: Omit<typeof schema.voiceChecks.$inferInsert, 'audioRecordId'>;
  const consented = await subjectsWithActiveConsent(db, [subject], 'voice_verification');
  const enrollment = consented.has(subject.id) ? await activeEnrollment(db, subject) : undefined;
  if (!consented.has(subject.id)) {
    values = { result: 'no_consent' };
  } else if (!enrollment) {
    values = { result: 'not_enrolled' };
  } else {
    try {
      const checked = await voice.verify({
        audioKey: recording.s3Key,
        voiceprintKey: enrollment.voiceprintKey,
      });
      values = {
        result: checked.result,
        score: checked.result === 'too_short' ? null : checked.score,
        speechSeconds: checked.speechSeconds,
        threshold: checked.threshold,
        modelRevision: checked.modelRevision,
      };
    } catch (err) {
      logger.warn({ err, audioRecordId: recording.id }, 'voice check unavailable');
      values = { result: 'unavailable' };
    }
  }
  const row = { score: null, speechSeconds: null, threshold: null, modelRevision: null, ...values };
  await db
    .insert(schema.voiceChecks)
    .values({ audioRecordId: recording.id, ...row })
    .onConflictDoUpdate({
      target: schema.voiceChecks.audioRecordId,
      set: { ...row, checkedAt: new Date() },
    });
  return { result: row.result, score: row.score ?? null, threshold: row.threshold ?? null };
}

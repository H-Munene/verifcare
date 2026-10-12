import type { ScheduledHandler } from 'aws-lambda';
import { and, inArray, lt } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import type { Db } from './db/client.js';
import { getLambdaDb } from './db/lambdaDb.js';
import * as schema from './db/schema.js';

// Real logic (HEZ-23 follow-up) - a visit still 'scheduled' (never checked in) or 'in_progress'
// (checked in but never checked out) once its own scheduledEnd has passed is a missed visit,
// exactly the two ways of "not completing checkout" a real caregiver visit can fail. Exported as a
// plain function, not inlined into the handler, so it can be exercised directly against a real
// Postgres in an integration test the same way every route's own business logic already is -
// `handler` below is the only part that actually needs a live Lambda environment (getLambdaDb()'s
// Secrets Manager credential resolution).
//
// Raises one missed-visit alert per missed visit (2026-09-27, the Compliance tab's alert-response
// report, which had nothing to measure until alerts existed). The product owner chose one shared
// alert per visit over one per supervisor: missed-visit handling is a collective supervisor
// responsibility (routes/notifications.ts already lets any supervisor acknowledge any alert), so
// the alert has no single recipient (recipient_user_id NULL = every supervisor) and the report
// measures response time from `sent_at` to whoever acknowledged it. SNS delivery
// (infra/lib/missedVisitSweep.ts's ALERTS_TOPIC_ARN) is still not wired: the supervisor console's
// alerts bell and Overview are the in-app channel.
//
// One transaction: the status change, the alerts and their audit rows commit together, so a
// failure can't leave a missed visit with no alert. The UPDATE ... RETURNING is also what picks
// the visits (not a SELECT first), so a visit checked out a moment before can't be swept anyway.
// The unique index uq_notification_log_missed_visit makes the alert insert idempotent.
export async function sweepMissedVisits(db: Db): Promise<{ missedVisitIds: string[] }> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const missed = await tx
      .update(schema.visitSchedules)
      .set({ status: 'missed', updatedAt: now })
      .where(
        and(
          inArray(schema.visitSchedules.status, ['scheduled', 'in_progress']),
          lt(schema.visitSchedules.scheduledEnd, now),
        ),
      )
      .returning({ id: schema.visitSchedules.id });
    if (missed.length === 0) {
      return { missedVisitIds: [] };
    }

    const missedVisitIds = missed.map((row) => row.id);
    await tx
      .insert(schema.notificationLog)
      .values(
        missedVisitIds.map((visitScheduleId) => ({
          type: 'missed_visit',
          visitScheduleId,
          recipientUserId: null,
          channel: 'in_app',
          sentAt: now,
        })),
      )
      .onConflictDoNothing();
    for (const id of missedVisitIds) {
      await recordAudit(tx, {
        actorUserId: null,
        action: 'visit_schedule.mark_missed',
        entityType: 'visit_schedule',
        entityId: id,
        metadata: { reason: 'scheduled end passed without a checkout' },
      });
    }
    return { missedVisitIds };
  });
}

export const handler: ScheduledHandler = async (event) => {
  console.log('missed-visit-sweep invoked', { time: event.time });
  const db = await getLambdaDb();
  const { missedVisitIds } = await sweepMissedVisits(db);
  console.log('missed-visit-sweep completed', { missedCount: missedVisitIds.length });
};

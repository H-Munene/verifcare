import type { ScheduledHandler } from 'aws-lambda';
import { and, inArray, lt } from 'drizzle-orm';
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
// Deliberately does not touch `notification_log`/SNS yet, even though both are already wired
// (infra/lib/missedVisitSweep.ts's ALERTS_TOPIC_ARN, schema.ts's notification_log 'missed_visit'
// type) - no Alerts UI exists anywhere in this app yet to consume either, and who the
// recipientUserId(s) should be (every supervisor? a fixed on-call user?) was never asked or
// answered. Left for a real Alerts feature to answer, not guessed here.
export async function sweepMissedVisits(db: Db): Promise<{ missedVisitIds: string[] }> {
  const overdue = await db
    .select({ id: schema.visitSchedules.id })
    .from(schema.visitSchedules)
    .where(
      and(
        inArray(schema.visitSchedules.status, ['scheduled', 'in_progress']),
        lt(schema.visitSchedules.scheduledEnd, new Date()),
      ),
    );
  if (overdue.length === 0) {
    return { missedVisitIds: [] };
  }

  const missedVisitIds = overdue.map((row) => row.id);
  await db
    .update(schema.visitSchedules)
    .set({ status: 'missed', updatedAt: new Date() })
    .where(inArray(schema.visitSchedules.id, missedVisitIds));
  return { missedVisitIds };
}

export const handler: ScheduledHandler = async (event) => {
  console.log('missed-visit-sweep invoked', { time: event.time });
  const db = await getLambdaDb();
  const { missedVisitIds } = await sweepMissedVisits(db);
  console.log('missed-visit-sweep completed', { missedCount: missedVisitIds.length });
};

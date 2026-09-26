import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './client.js';
import * as schema from './schema.js';

// What counts as "has a photo for check-in": an 'active' biometric_enrollments row - the only
// status check-in's face match compares against (routes/checkin.ts). A 'flagged' photo is still
// waiting for a supervisor's review, and 'superseded'/'deleted' ones are history. Shared by the
// scheduling guardrail (routes/visitSchedules.ts) and the dependant responses' checkinPhotoStatus, so
// the app's "photo needed" alert and the scheduling rule can never disagree.
export const isCheckinPhoto = eq(schema.biometricEnrollments.status, 'active');

/**
 * Where each dependant's check-in photo stands: 'ready' (an active photo check-in can match),
 * 'awaiting_review' (only a flagged one, waiting for a supervisor), or 'missing'. The distinction
 * matters to the family app: someone who just added a photo that was flagged shouldn't be told to
 * add one. Only 'ready' lets a visit be scheduled. One query however many dependants.
 */
export type CheckinPhotoStatus = 'ready' | 'awaiting_review' | 'missing';

export async function checkinPhotoStatuses(
  db: Db,
  dependantIds: string[],
): Promise<Map<string, CheckinPhotoStatus>> {
  const statuses = new Map<string, CheckinPhotoStatus>(dependantIds.map((id) => [id, 'missing']));
  if (dependantIds.length === 0) {
    return statuses;
  }
  const rows = await db
    .selectDistinct({
      dependantId: schema.biometricEnrollments.dependantId,
      status: schema.biometricEnrollments.status,
    })
    .from(schema.biometricEnrollments)
    .where(
      and(
        inArray(schema.biometricEnrollments.status, ['active', 'flagged']),
        inArray(schema.biometricEnrollments.dependantId, dependantIds),
      ),
    );
  for (const row of rows) {
    if (!row.dependantId) {
      continue;
    }
    if (row.status === 'active') {
      statuses.set(row.dependantId, 'ready');
    } else if (statuses.get(row.dependantId) === 'missing') {
      statuses.set(row.dependantId, 'awaiting_review');
    }
  }
  return statuses;
}

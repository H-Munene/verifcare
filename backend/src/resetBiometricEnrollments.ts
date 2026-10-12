import { count } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import type { Db } from './db/client.js';
import * as schema from './db/schema.js';

// Wipes every biometric_enrollments row - caregivers and dependants, every status - so enrollment
// photos can be retaken from scratch through the normal flows (2026-09-26, user request: the first
// round of test photos wasn't taken properly). Run only through the migration-runner Lambda
// (migrate.ts), the one thing besides the API that can reach the private RDS instance.
//
// This covers the database side only. The photos themselves (the enrollments S3 bucket) and their
// face vectors (the Rekognition collection) are removed separately with the AWS CLI - the
// migration runner deliberately has no S3 or Rekognition grants, and a one-off cleanup isn't
// worth widening them.
//
// Nothing else holds a reference to these rows: no table has a foreign key to
// biometric_enrollments, check-in verification_attempts store GPS metadata only, and audit_log
// entries (append-only by trigger) stay as history.

/** The value `confirm` must equal before anything is deleted. */
export const RESET_BIOMETRIC_ENROLLMENTS_CONFIRMATION = 'delete-all-biometric-enrollments';

export interface ResetBiometricEnrollmentsResult {
  deleted: boolean;
  /** What was there before the call, by subject type and status. */
  counts: { subjectType: string; status: string; count: number }[];
}

/**
 * Counts every enrollment row, and deletes them all only when `confirm` is exactly
 * RESET_BIOMETRIC_ENROLLMENTS_CONFIRMATION - anything else is a dry run, so a mistyped or
 * partial event can never delete by accident.
 */
export async function resetBiometricEnrollments(
  db: Db,
  confirm: string | undefined,
): Promise<ResetBiometricEnrollmentsResult> {
  return db.transaction(async (tx) => {
    const counts = await tx
      .select({
        subjectType: schema.biometricEnrollments.subjectType,
        status: schema.biometricEnrollments.status,
        count: count(),
      })
      .from(schema.biometricEnrollments)
      .groupBy(schema.biometricEnrollments.subjectType, schema.biometricEnrollments.status)
      .orderBy(schema.biometricEnrollments.subjectType, schema.biometricEnrollments.status);

    const deleted = confirm === RESET_BIOMETRIC_ENROLLMENTS_CONFIRMATION;
    if (deleted) {
      await tx.delete(schema.biometricEnrollments);
      // System actor (a job, not a request) - actorUserId null per audit.ts's own convention.
      // No single entityId: this wipes every row, not one record.
      await recordAudit(tx, {
        actorUserId: null,
        action: 'biometric_enrollment.reset',
        entityType: 'biometric_enrollment',
        entityId: null,
        metadata: { counts },
      });
    }
    return { deleted, counts };
  });
}

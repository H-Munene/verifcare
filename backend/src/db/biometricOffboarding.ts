// Shared by routes/caregivers.ts and routes/dependants.ts (HEZ-85): when a subject is
// offboarded/deactivated, their indexed face vectors are removed from the Rekognition Collection -
// confirmed with the user as the chosen tradeoff (over keeping them indefinitely), since someone
// removed for cause re-registering under a new identity undetected was judged the bigger risk than
// the collection accumulating stale entries. Runs best-effort, after the caller's own DB
// transaction has already committed the subject's own deactivation: an external AWS call has no
// business holding that transaction's locks/connection open, and the subject's own status change
// is the authoritative action here - a failure in this cleanup step is logged, not fatal to the
// request that triggered it.
//
// Both 'active' and 'superseded' rows are cleaned up, not just 'active' - a superseded row (an
// older photo re-enrollment left behind) is still indexed under this same subject in the
// collection, and offboarding means none of this subject's face vectors should remain searchable,
// not just their current one.

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { logger } from '../logger.js';
import type { BiometricFaceCollection } from './biometricFaceCollection.js';
import type { Db } from './client.js';
import * as schema from './schema.js';

export async function cleanupBiometricEnrollmentsForSubject(
  db: Db,
  faceCollection: BiometricFaceCollection,
  subjectType: 'caregiver' | 'dependant',
  subjectId: string,
): Promise<void> {
  const subjectColumn =
    subjectType === 'caregiver'
      ? schema.biometricEnrollments.caregiverId
      : schema.biometricEnrollments.dependantId;
  const indexedCondition = and(
    eq(subjectColumn, subjectId),
    isNotNull(schema.biometricEnrollments.rekognitionFaceId),
    inArray(schema.biometricEnrollments.status, ['active', 'superseded']),
  );

  try {
    const rows = await db
      .select({ rekognitionFaceId: schema.biometricEnrollments.rekognitionFaceId })
      .from(schema.biometricEnrollments)
      .where(indexedCondition);
    const faceIds = rows
      .map((row) => row.rekognitionFaceId)
      .filter((id): id is string => id !== null);
    if (faceIds.length === 0) {
      return;
    }

    await faceCollection.deleteFaces(faceIds);
    await db
      .update(schema.biometricEnrollments)
      .set({ status: 'deleted', updatedAt: new Date() })
      .where(indexedCondition);
  } catch (err) {
    logger.error(
      { err, subjectType, subjectId },
      'Failed to clean up biometric enrollments on offboarding - subject deactivation still succeeded',
    );
  }
}

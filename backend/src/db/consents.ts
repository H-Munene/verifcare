import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from './client.js';
import * as schema from './schema.js';

// Where every "has consent" and "record consent" rule lives (2026-09-27), so the consent screen's
// grant (routes/terms.ts), dependant registration (routes/dependants.ts) and the scheduling guard
// (routes/visitSchedules.ts) can never disagree about what counts.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type ConsentType = (typeof schema.consentTypeEnum.enumValues)[number];

export interface ConsentSubject {
  subjectType: 'caregiver' | 'dependant';
  // caregivers.user_id or dependants.id.
  id: string;
}

// Both consents the apps' consent screen asks for, so accepting the terms records both.
export const TERMS_CONSENT_TYPES: readonly ConsentType[] = ['location_verification', 'visit_audio'];

// A record counts until it's revoked (routes/consentRecords.ts's revoke sets revoked_at; rows are
// never deleted, so the history of who granted and withdrew what stays intact).
export const isActiveConsent = isNull(schema.consentRecords.revokedAt);

function subjectCondition(subjects: ConsentSubject[]) {
  const caregiverIds = subjects.filter((s) => s.subjectType === 'caregiver').map((s) => s.id);
  const dependantIds = subjects.filter((s) => s.subjectType === 'dependant').map((s) => s.id);
  return or(
    caregiverIds.length > 0 ? inArray(schema.consentRecords.caregiverId, caregiverIds) : undefined,
    dependantIds.length > 0 ? inArray(schema.consentRecords.dependantId, dependantIds) : undefined,
  );
}

/**
 * The subjects (of those given) holding an active consent of [consentType], as a set of ids.
 * One query however many subjects.
 */
export async function subjectsWithActiveConsent(
  db: Db | Tx,
  subjects: ConsentSubject[],
  consentType: ConsentType,
): Promise<Set<string>> {
  if (subjects.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({
      caregiverId: schema.consentRecords.caregiverId,
      dependantId: schema.consentRecords.dependantId,
    })
    .from(schema.consentRecords)
    .where(
      and(
        isActiveConsent,
        eq(schema.consentRecords.consentType, consentType),
        subjectCondition(subjects),
      ),
    );
  return new Set(rows.map((row) => (row.caregiverId ?? row.dependantId)!));
}

/**
 * Records [consentTypes] for each subject, granted by [grantedBy], skipping any subject/type that
 * already has an active record - so accepting the terms again, or registering a dependant who
 * somehow already has consent, never piles up duplicate grants that would each need revoking.
 */
// ponytail: check-then-insert, so two simultaneous grants for the same subject could both insert;
// a partial unique index on (subject, consent_type) WHERE revoked_at IS NULL would close that, once
// any existing duplicates from POST /consent-records are cleaned up.
export async function grantConsents(
  db: Db | Tx,
  subjects: ConsentSubject[],
  grantedBy: string,
  consentTypes: readonly ConsentType[] = TERMS_CONSENT_TYPES,
): Promise<void> {
  if (subjects.length === 0) {
    return;
  }
  const existing = await db
    .select({
      caregiverId: schema.consentRecords.caregiverId,
      dependantId: schema.consentRecords.dependantId,
      consentType: schema.consentRecords.consentType,
    })
    .from(schema.consentRecords)
    .where(
      and(
        isActiveConsent,
        inArray(schema.consentRecords.consentType, [...consentTypes]),
        subjectCondition(subjects),
      ),
    );
  // Ids are UUIDs from two different tables, so an id alone identifies the subject.
  const held = new Set(
    existing.map((row) => `${row.caregiverId ?? row.dependantId}:${row.consentType}`),
  );
  const rows = subjects.flatMap((subject) =>
    consentTypes
      .filter((consentType) => !held.has(`${subject.id}:${consentType}`))
      .map((consentType) => ({
        subjectType: subject.subjectType,
        caregiverId: subject.subjectType === 'caregiver' ? subject.id : null,
        dependantId: subject.subjectType === 'dependant' ? subject.id : null,
        consentType,
        grantedBy,
      })),
  );
  if (rows.length > 0) {
    await db.insert(schema.consentRecords).values(rows);
  }
}

/**
 * Whether [userId] has ticked both consent boxes on the consent screen in any accepted version of
 * the terms. Consent given once isn't withdrawn by a later terms version, so any such acceptance
 * counts (withdrawal is per subject, through POST /consent-records/{id}/revoke).
 */
export async function hasGivenTermsConsents(db: Db | Tx, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.termsAcceptances.id })
    .from(schema.termsAcceptances)
    .where(
      and(
        eq(schema.termsAcceptances.userId, userId),
        eq(schema.termsAcceptances.locationConsent, true),
        eq(schema.termsAcceptances.audioConsent, true),
      ),
    )
    .limit(1);
  return row !== undefined;
}

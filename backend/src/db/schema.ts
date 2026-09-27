// Drizzle schema-as-code, ported from docs/schema.sql (Linear HEZ-8).
//
// Column names are written camelCase here and mapped to snake_case in generated SQL by
// drizzle.config.ts's `casing: 'snake_case'` option - verified column-by-column against
// drizzle-orm's toSnakeCase() before relying on it, so no column needs an explicit name string.
// The runtime `drizzle()` client (HEZ-27) must be constructed with the same `casing: 'snake_case'`
// option or query-time column resolution will mismatch what these migrations create.
//
// Not ported here - not representable in Drizzle's schema model, so left for HEZ-9's hand-written
// custom migrations instead:
//   - `uuid_generate_v7()`, `set_updated_at()`, `forbid_update_delete()` and the extensions they need.
//   - The five `trg_*_updated_at` triggers. `updatedAt` columns below are plain `DEFAULT now()`
//     columns (matching schema.sql), but nothing here keeps them current on UPDATE - that guarantee
//     only exists once HEZ-9 adds the trigger, and it must hold for every writer, not just this app.
//   - `trg_verification_attempts_append_only` / `trg_audit_log_append_only` (reject UPDATE/DELETE).
//   - The two `EXCLUDE USING gist` constraints on `visit_schedules` (no `exclude()` in Drizzle's
//     pg-core at all - confirmed against the installed version).
//
// CHECK constraints that were unnamed inline constraints in schema.sql (Postgres would have
// auto-named them) are given explicit descriptive names here, since Drizzle's `check()` requires
// one: `chk_<table>_<what>`, consistent with schema.sql's already-named constraints.

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgSequence,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ============================================================================
// Enum types
// ============================================================================

export const subjectTypeEnum = pgEnum('subject_type', ['caregiver', 'dependant']);
export const dependantStatusEnum = pgEnum('dependant_status', ['active', 'deactivated']);
// Renamed from dependant_gender (2026-09-22, HEZ-54) - caregivers now need the same concept
// (male/female), and the user confirmed one shared vocabulary over a second near-duplicate enum.
// A type rename only, no data rewrite - dependants.gender's existing values are untouched.
export const personGenderEnum = pgEnum('person_gender', ['male', 'female']);
// Confirmed with the user as exactly these three (2026-09-22, HEZ-54) - deliberately narrower than
// a free-text job title, so check-in/reporting can rely on a fixed, known vocabulary.
export const caregiverOccupationEnum = pgEnum('caregiver_occupation', [
  'nurse',
  'community_health_worker',
  'caregiver',
]);
export const verificationAttemptTypeEnum = pgEnum('verification_attempt_type', [
  'geofence',
  'caregiver_liveness',
  'dependant_liveness',
]);
export const consentTypeEnum = pgEnum('consent_type', [
  'biometric_verification',
  'audio_cognitive_monitoring',
]);
// Kenyan identity document types accepted when registering a brand-new family-member user
// (HEZ-86 revision, 2026-09-21) - confirmed with the user as exactly these two, an enum rather
// than text+CHECK since (unlike biometric_enrollments.status) there is no near-term need to add a
// value inside the same migration that also uses it.
export const idTypeEnum = pgEnum('id_type', ['national_id', 'passport']);

// Visit task checklist (docs/visit-task-checklist-plan.md) - a closed set confirmed with the user
// before implementation, not yet used anywhere else in the same migration, so (unlike
// biometric_enrollments.status) a native enum has no same-transaction ADD VALUE restriction to
// worry about here.
export const taskCompletionStatusEnum = pgEnum('task_completion_status', [
  'completed',
  'not_completed',
  'not_applicable',
]);
export const taskSkipReasonEnum = pgEnum('task_skip_reason', [
  'client_declined',
  'client_unavailable',
  'equipment_unavailable',
  'other',
]);

// ============================================================================
// users
// ============================================================================

export const users = pgTable(
  'users',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    cognitoSub: text().notNull().unique('uq_users_cognito_sub'),
    email: text().unique('uq_users_email'),
    phoneNumber: text().unique('uq_users_phone_number'),
    fullName: text().notNull(),
    role: text().notNull(),
    status: text().notNull().default('active'),
    // Identity document captured when a supervisor/family_member registers a brand-new
    // family-member user (HEZ-86 revision) - nullable since existing rows and every other role
    // predate this and have no backfill mechanism, matching dependants.county's own
    // nullable-column-but-validated-at-the-API-layer treatment for the same reason.
    idType: idTypeEnum(),
    idNumber: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('chk_users_role', sql`${table.role} IN ('supervisor', 'caregiver', 'family_member')`),
    check('chk_users_status', sql`${table.status} IN ('active', 'suspended', 'deactivated')`),
    check(
      'chk_users_phone_required_unless_supervisor',
      sql`${table.role} = 'supervisor' OR ${table.phoneNumber} IS NOT NULL`,
    ),
    check(
      'chk_users_id_type_number_together',
      sql`(${table.idType} IS NULL) = (${table.idNumber} IS NULL)`,
    ),
    index('idx_users_role').on(table.role),
  ],
);

// ============================================================================
// caregivers (1:1 extension of users)
// ============================================================================

// Backs employeeNumber's own DB-generated default below (2026-09-22, HEZ-54) - the user asked for
// employee numbers to be auto-assigned at registration, not supervisor-entered, and a DB sequence
// is the only concurrency-safe way to hand out a strictly-increasing number under simultaneous
// registrations (an app-side MAX(...)+1 read is a real race condition, not just a theoretical one).
export const caregiverEmployeeNumberSeq = pgSequence('caregiver_employee_number_seq', {
  startWith: 1,
  increment: 1,
});

export const caregivers = pgTable('caregivers', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id),
  // dob/gender/occupation added 2026-09-22 (HEZ-54) - nullable despite being required at
  // registration going forward, same "existing rows predate this" treatment users.idType/idNumber
  // already got, rather than forcing a NOT NULL that could break any already-registered caregiver.
  dob: date(),
  gender: personGenderEnum(),
  occupation: caregiverOccupationEnum(),
  // Auto-generated ('CG-' + a zero-padded sequence value, e.g. CG-0001) rather than
  // supervisor-entered - matches the wireframe's own example ("CG-1042"). Still a plain nullable
  // column, not NOT NULL, for the same pre-existing-rows reason as above (also means PATCH can
  // still correct one by hand later if a real-world need for that ever comes up, unchanged from
  // before).
  employeeNumber: text()
    .unique('uq_caregivers_employee_number')
    .default(sql`'CG-' || lpad(nextval('caregiver_employee_number_seq')::text, 4, '0')`),
  // Auto-populated to the actual registration date rather than supervisor-entered, per the same
  // request as employeeNumber above.
  hireDate: date().default(sql`CURRENT_DATE`),
  active: boolean().notNull().default(true),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// dependants
// ============================================================================

export const dependants = pgTable(
  'dependants',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    fullName: text().notNull(),
    dob: date().notNull(),
    gender: personGenderEnum(),
    homeAddressText: text(),
    // Free-text clinical/care context (e.g. "early-stage dementia, lives alone, mobility aid
    // required") - a general description of the dependant's condition for caregivers/supervisors,
    // not a structured diagnosis field. Optional, same nullable-free-text treatment as
    // homeAddressText.
    primaryConditionSummary: text(),
    // Kenyan administrative geography (HEZ-86) - resolved client-side in the admin web app via a
    // point-in-polygon lookup against IEBC ward boundary GeoJSON as the supervisor places the
    // geofence pin, then sent here as plain names. Nullable at the DB level (existing rows
    // predate this feature and have no backfill mechanism yet), even though the create endpoint
    // requires all three for every new registration - matches homeAddressText's own
    // nullable-column-but-validated-at-the-API-layer treatment for the same reason.
    county: text(),
    constituency: text(),
    ward: text(),
    geofenceLat: doublePrecision().notNull(),
    geofenceLng: doublePrecision().notNull(),
    geofenceRadiusMeters: integer().notNull(),
    cognitiveMonitoringEnabled: boolean().notNull().default(false),
    status: dependantStatusEnum().notNull().default('active'),
    registeredBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('chk_dependants_geofence_radius_positive', sql`${table.geofenceRadiusMeters} > 0`),
    index('idx_dependants_registered_by').on(table.registeredBy),
    index('idx_dependants_status').on(table.status),
  ],
);

// ============================================================================
// dependant_family_members
// ============================================================================

export const dependantFamilyMembers = pgTable(
  'dependant_family_members',
  {
    dependantId: uuid()
      .notNull()
      .references(() => dependants.id),
    familyMemberUserId: uuid()
      .notNull()
      .references(() => users.id),
    relationship: text(),
    isPrimaryContact: boolean().notNull().default(false),
    addedBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.dependantId, table.familyMemberUserId] }),
    index('idx_dependant_family_members_family_member').on(table.familyMemberUserId),
    index('idx_dependant_family_members_added_by').on(table.addedBy),
    // At most one primary contact per dependant.
    uniqueIndex('uq_dependant_family_members_primary_contact')
      .on(table.dependantId)
      .where(sql`${table.isPrimaryContact}`),
  ],
);

// ============================================================================
// dependant_care_tasks - the care plan itself (docs/visit-task-checklist-plan.md), authored by a
// supervisor on a dedicated Care Plan screen, not part of dependant registration.
// ============================================================================

export const dependantCareTasks = pgTable(
  'dependant_care_tasks',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    dependantId: uuid()
      .notNull()
      .references(() => dependants.id),
    title: text().notNull(),
    description: text(),
    // Free text, not a fixed ADL/IADL enum - tasks are authored per dependant by the supervisor (a
    // bespoke care plan), not selected from a fixed master taxonomy, so a rigid category enum
    // would fight that flexibility rather than support it. Purely a display grouping label, never
    // validated against a closed list.
    category: text(),
    required: boolean().notNull().default(true),
    // A retired task keeps its history (existing visit_task_completions rows referencing it stay
    // valid) but stops appearing on future visits - deletion is never used for this table, the
    // same reasoning dependants.status/caregivers.active already establish elsewhere.
    active: boolean().notNull().default(true),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_dependant_care_tasks_dependant_active').on(table.dependantId, table.active),
  ],
);

// ============================================================================
// biometric_enrollments
// ============================================================================

export const biometricEnrollments = pgTable(
  'biometric_enrollments',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    subjectType: subjectTypeEnum().notNull(),
    caregiverId: uuid().references(() => caregivers.userId),
    dependantId: uuid().references(() => dependants.id),
    s3Key: text().notNull().unique('uq_biometric_enrollments_s3_key'),
    imageOrder: smallint().notNull(),
    qualityScore: real(),
    // Plain text + CHECK, not a native pgEnum - matching users.status's own established pattern in
    // this file. A real pgEnum was tried first for HEZ-85's new 'flagged' value and reverted:
    // Postgres forbids using a freshly-added enum value ("ALTER TYPE ... ADD VALUE") within the
    // same transaction that added it, and drizzle-orm's migrate() always batches every not-yet-
    // applied migration file into one single transaction (confirmed directly - not just when a
    // fresh database applies its whole history at once, which is exactly what every fresh test-DB
    // run and CI run does). Splitting the enum-add and its first use into separate migration files
    // does not avoid this, since both still count as "not yet applied" together. text()+CHECK has
    // no such restriction, since altering a CHECK constraint is just an ordinary DDL statement.
    status: text().notNull().default('active'),
    // The Rekognition Collection FaceId for this image (HEZ-85) - only ever set once the image is
    // actually indexed (status 'active'/'superseded'; never set while 'flagged', since indexing is
    // deliberately deferred until a supervisor approves it). Needed to call DeleteFaces later
    // (offboarding cleanup) - the collection has no other way to look up which vectors belong to
    // which enrollment row.
    rekognitionFaceId: text(),
    // The other subject this image matched above the duplicate-detection threshold, and the
    // similarity score at the time - populated only when status is (or was) 'flagged', for a
    // supervisor to review. No FK: matchedSubjectId may point at either caregivers.userId or
    // dependants.id depending on matchedSubjectType, the same "can't FK to two tables" reasoning
    // audit_log.entityId already uses.
    matchedSubjectType: subjectTypeEnum(),
    matchedSubjectId: uuid(),
    matchedSimilarity: real(),
    enrolledBy: uuid()
      .notNull()
      .references(() => users.id),
    enrolledAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('chk_biometric_enrollments_image_order', sql`${table.imageOrder} BETWEEN 1 AND 3`),
    check(
      'chk_biometric_enrollments_subject',
      sql`(${table.subjectType} = 'caregiver' AND ${table.caregiverId} IS NOT NULL AND ${table.dependantId} IS NULL) OR
          (${table.subjectType} = 'dependant' AND ${table.dependantId} IS NOT NULL AND ${table.caregiverId} IS NULL)`,
    ),
    check(
      'chk_biometric_enrollments_status',
      sql`${table.status} IN ('active', 'superseded', 'deleted', 'flagged')`,
    ),
    check(
      'chk_biometric_enrollments_flagged_has_match',
      sql`${table.status} != 'flagged' OR (${table.matchedSubjectType} IS NOT NULL AND ${table.matchedSubjectId} IS NOT NULL AND ${table.matchedSimilarity} IS NOT NULL)`,
    ),
    index('idx_biometric_enrollments_caregiver_active').on(table.caregiverId, table.status),
    index('idx_biometric_enrollments_dependant_active').on(table.dependantId, table.status),
    index('idx_biometric_enrollments_enrolled_by').on(table.enrolledBy),
    // Supports GET /biometric-enrollments/flagged (HEZ-85), a cross-subject listing with no
    // caregiverId/dependantId filter to drive off the two composite indexes above.
    index('idx_biometric_enrollments_flagged')
      .on(table.id)
      .where(sql`${table.status} = 'flagged'`),
  ],
);

// ============================================================================
// visit_schedules
// ============================================================================

export const visitSchedules = pgTable(
  'visit_schedules',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    caregiverId: uuid()
      .notNull()
      .references(() => caregivers.userId),
    dependantId: uuid()
      .notNull()
      .references(() => dependants.id),
    scheduledStart: timestamp({ withTimezone: true }).notNull(),
    scheduledEnd: timestamp({ withTimezone: true }).notNull(),
    status: text().notNull().default('scheduled'),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'chk_visit_schedules_status',
      sql`${table.status} IN ('scheduled', 'in_progress', 'completed', 'missed', 'cancelled', 'investigated')`,
    ),
    check(
      'chk_visit_schedules_end_after_start',
      sql`${table.scheduledEnd} > ${table.scheduledStart}`,
    ),
    index('idx_visit_schedules_caregiver_start').on(table.caregiverId, table.scheduledStart),
    index('idx_visit_schedules_dependant_start').on(table.dependantId, table.scheduledStart),
    index('idx_visit_schedules_status').on(table.status),
    index('idx_visit_schedules_created_by').on(table.createdBy),
    // `excl_visit_schedules_caregiver_overlap` / `excl_visit_schedules_dependant_overlap`
    // (EXCLUDE USING gist, double-booking prevention) are added by HEZ-9 - see file header.
  ],
);

// ============================================================================
// visit_task_completions - one row per (visit, task), filled in live during the visit
// (docs/visit-task-checklist-plan.md). No updatedAt/trigger and no forbid_update_delete trigger -
// this table is genuinely mutable while the visit is in_progress (a caregiver correcting
// themselves before checkout is normal, matching verification_events' own upsert-while-in-progress
// treatment, not an audit violation), and "locked after checkout" is enforced at the application
// layer (the backend rejects a write once visit_schedules.status is no longer in_progress) rather
// than a DB trigger - a supervisor's later correction goes to the existing audit_log table instead
// of editing this row directly.
// ============================================================================

export const visitTaskCompletions = pgTable(
  'visit_task_completions',
  {
    visitScheduleId: uuid()
      .notNull()
      .references(() => visitSchedules.id),
    careTaskId: uuid()
      .notNull()
      .references(() => dependantCareTasks.id),
    status: taskCompletionStatusEnum().notNull(),
    reason: taskSkipReasonEnum(),
    notes: text(),
    completedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.visitScheduleId, table.careTaskId] }),
    // Mirrors this schema's existing style of encoding "these columns are only valid together" as
    // a CHECK (verification_events, biometric_enrollments both already do this) - a reason only
    // makes sense for a genuinely skipped task, never one marked done or explicitly N/A.
    check(
      'chk_visit_task_completions_reason',
      sql`(${table.status} = 'not_completed' AND ${table.reason} IS NOT NULL) OR
          (${table.status} != 'not_completed' AND ${table.reason} IS NULL)`,
    ),
    index('idx_visit_task_completions_visit').on(table.visitScheduleId),
  ],
);

// ============================================================================
// verification_events
// ============================================================================

export const verificationEvents = pgTable(
  'verification_events',
  {
    visitScheduleId: uuid()
      .primaryKey()
      .references(() => visitSchedules.id),
    checkinAt: timestamp({ withTimezone: true }),
    checkoutAt: timestamp({ withTimezone: true }),
    checkinGpsLat: doublePrecision(),
    checkinGpsLng: doublePrecision(),
    distanceFromGeofenceMeters: doublePrecision(),
    // Where the caregiver was when they checked out, and how far that was from the geofence
    // centre (migration 0015): checkout must happen inside the home's radius, like check-in, and
    // this is the record that it did. Null for visits checked out before the rule existed.
    checkoutGpsLat: doublePrecision(),
    checkoutGpsLng: doublePrecision(),
    checkoutDistanceFromGeofenceMeters: doublePrecision(),
    caregiverMatchConfidence: numeric({ precision: 5, scale: 2 }),
    dependantMatchConfidence: numeric({ precision: 5, scale: 2 }),
    caregiverLivenessPassed: boolean(),
    dependantLivenessPassed: boolean(),
    // Hash of the short-lived session token, not the token itself (see schema.sql's file header).
    sessionTokenHash: text(),
    // When the current sessionTokenHash was issued (HEZ-33 originally derived this indirectly from
    // the matching passing 'geofence' verification_attempts row's attemptedAt instead of a direct
    // column - revisited while building HEZ-34's actual session-token verification, which needs
    // this on every one of the four remaining check-in requests: a direct column avoids an extra
    // cross-table query on every check-in request and decouples the auth check from
    // verification_attempts' own audit-log shape).
    sessionTokenIssuedAt: timestamp({ withTimezone: true }),
    // No pending-challenge columns here (a HEZ-34 first draft had them, dropped in the same
    // session): caregiver/dependant verification is a single-photo check now, not a
    // challenge-response flow, so there is no pending challenge to track between the upload-url
    // and submit calls - see routes/checkin.ts's header comment for the full reasoning behind the
    // reversal.
  },
  (table) => [
    check(
      'chk_verification_events_caregiver_match_confidence_range',
      sql`${table.caregiverMatchConfidence} BETWEEN 0 AND 100`,
    ),
    check(
      'chk_verification_events_dependant_match_confidence_range',
      sql`${table.dependantMatchConfidence} BETWEEN 0 AND 100`,
    ),
    check(
      'chk_verification_events_checkout_after_checkin',
      sql`${table.checkoutAt} IS NULL OR (${table.checkinAt} IS NOT NULL AND ${table.checkoutAt} >= ${table.checkinAt})`,
    ),
  ],
);

// ============================================================================
// verification_attempts (append-only audit trail)
// ============================================================================

export const verificationAttempts = pgTable(
  'verification_attempts',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    visitScheduleId: uuid()
      .notNull()
      .references(() => visitSchedules.id),
    attemptType: verificationAttemptTypeEnum().notNull(),
    passed: boolean().notNull(),
    failureReason: text(),
    metadata: jsonb(),
    attemptedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_verification_attempts_visit_time').on(table.visitScheduleId, table.attemptedAt),
    // `trg_verification_attempts_append_only` (rejects UPDATE/DELETE) is added by HEZ-9.
  ],
);

// ============================================================================
// visit_resolutions (append-only, 0016) - a supervisor's account of how a missed visit or a failed
// check was resolved, for the Compliance tab's exceptions log. Append-only so the history an
// auditor sees is never rewritten: a later resolution supersedes an earlier one, the latest wins.
// ============================================================================

export const VISIT_RESOLUTION_OUTCOMES = [
  'caregiver_absent',
  'family_cancelled',
  'dependant_unavailable',
  'device_or_network_issue',
  'visit_took_place',
  'verified_manually',
  'other',
] as const;
export type VisitResolutionOutcome = (typeof VISIT_RESOLUTION_OUTCOMES)[number];

export const visitResolutions = pgTable(
  'visit_resolutions',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    visitScheduleId: uuid()
      .notNull()
      .references(() => visitSchedules.id),
    outcome: text().$type<VisitResolutionOutcome>().notNull(),
    note: text().notNull(),
    resolvedBy: uuid()
      .notNull()
      .references(() => users.id),
    resolvedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'chk_visit_resolutions_outcome',
      sql`${table.outcome} IN ('caregiver_absent', 'family_cancelled', 'dependant_unavailable', 'device_or_network_issue', 'visit_took_place', 'verified_manually', 'other')`,
    ),
    check('chk_visit_resolutions_note', sql`length(btrim(${table.note})) > 0`),
    index('idx_visit_resolutions_visit').on(table.visitScheduleId, table.resolvedAt),
    // `trg_visit_resolutions_append_only` (rejects UPDATE/DELETE) is added by 0016.
  ],
);

// ============================================================================
// audio_records
// ============================================================================

export const audioRecords = pgTable(
  'audio_records',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    // No inline .references() here: the default FK constraint name it would generate
    // ("audio_records_verification_event_id_verification_events_visit_schedule_id_fk", 76 chars)
    // exceeds Postgres's 63-byte identifier limit and would be silently truncated. Named explicitly
    // via foreignKey() below instead.
    verificationEventId: uuid().notNull(),
    s3Key: text().notNull().unique('uq_audio_records_s3_key'),
    durationSeconds: integer(),
    riskScore: numeric({ precision: 5, scale: 4 }),
    modelVersion: text(),
    processedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    check('chk_audio_records_risk_score_range', sql`${table.riskScore} BETWEEN 0 AND 1`),
    index('idx_audio_records_verification_event').on(table.verificationEventId),
    foreignKey({
      name: 'fk_audio_records_verification_event',
      columns: [table.verificationEventId],
      foreignColumns: [verificationEvents.visitScheduleId],
    }),
  ],
);

// ============================================================================
// consent_records
// ============================================================================

export const consentRecords = pgTable(
  'consent_records',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    subjectType: subjectTypeEnum().notNull(),
    caregiverId: uuid().references(() => caregivers.userId),
    dependantId: uuid().references(() => dependants.id),
    consentType: consentTypeEnum().notNull(),
    grantedBy: uuid()
      .notNull()
      .references(() => users.id),
    grantedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
    // Who revoked it (0016), so the consent register can show it. Null on rows revoked before.
    revokedBy: uuid().references(() => users.id),
  },
  (table) => [
    check(
      'chk_consent_records_subject',
      sql`(${table.subjectType} = 'caregiver' AND ${table.caregiverId} IS NOT NULL AND ${table.dependantId} IS NULL) OR
          (${table.subjectType} = 'dependant' AND ${table.dependantId} IS NOT NULL AND ${table.caregiverId} IS NULL)`,
    ),
    index('idx_consent_records_caregiver').on(table.caregiverId),
    index('idx_consent_records_dependant').on(table.dependantId),
    index('idx_consent_records_type').on(table.consentType),
    index('idx_consent_records_granted_by').on(table.grantedBy),
  ],
);

// ============================================================================
// terms_acceptances (append-only) - a user accepting the app's terms of use and privacy notice
// (2026-09-26, the mobile apps' consent screen). Not consent_records: that table is consent given
// *about a subject* (a caregiver's or dependant's biometrics/audio), often by someone else on
// their behalf; this is the signed-in user agreeing to the terms for themselves. One row per
// document version accepted, so publishing a new version (src/terms.ts) asks everyone again while
// the record of what each person agreed to, and when, is kept.
// ============================================================================

export const termsAcceptances = pgTable(
  'terms_acceptances',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    // Which document: the caregiver and family-member apps have different terms.
    document: text().notNull(),
    version: text().notNull(),
    acceptedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // The consent screen's two checkboxes (migration 0014, terms v2): consent to photos being
    // used to verify identity at visits, and to audio being recorded during visits. Kept on the
    // acceptance as the append-only proof of what the person ticked, alongside the
    // consent_records rows the same acceptance creates (which can later be revoked). Null on v1
    // acceptances, which didn't ask - null means "not asked", not "refused".
    biometricConsent: boolean(),
    audioConsent: boolean(),
  },
  (table) => [
    check(
      'chk_terms_acceptances_document',
      sql`${table.document} IN ('caregiver', 'family_member')`,
    ),
    unique('uq_terms_acceptances_user_document_version').on(
      table.userId,
      table.document,
      table.version,
    ),
    // `trg_terms_acceptances_append_only` (rejects UPDATE/DELETE) is added by migration 0012.
  ],
);

// ============================================================================
// family_link_requests (2026-09-26) - a family member asking a dependant's primary contact to
// link them. The requester names the primary contact by exact email or phone and never learns
// whether that matched anyone (the request is stored and shown to them as pending either way);
// primaryContactUserId is only set when the contact belonged to a primary contact at the time, and
// only those requests reach anyone. The primary contact chooses which of their dependants to link
// when approving, so the requester never sees dependants' names before being linked.
// ============================================================================

export const familyLinkRequests = pgTable(
  'family_link_requests',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    requesterUserId: uuid()
      .notNull()
      .references(() => users.id),
    // The email (lower-cased) or E.164 phone number the requester typed, shown back to them.
    targetContact: text().notNull(),
    primaryContactUserId: uuid().references(() => users.id),
    relationship: text(),
    status: text().notNull().default('pending'),
    // The dependants the primary contact linked the requester to, when approved.
    linkedDependantIds: uuid().array(),
    decidedAt: timestamp({ withTimezone: true }),
    // When the requester saw the outcome in the app - until then it counts as an unread
    // notification for them.
    requesterSeenAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'chk_family_link_requests_status',
      sql`${table.status} IN ('pending', 'approved', 'rejected')`,
    ),
    check(
      'chk_family_link_requests_decision',
      sql`(${table.status} = 'pending' AND ${table.decidedAt} IS NULL) OR
          (${table.status} = 'rejected' AND ${table.decidedAt} IS NOT NULL) OR
          (${table.status} = 'approved' AND ${table.decidedAt} IS NOT NULL AND ${table.linkedDependantIds} IS NOT NULL)`,
    ),
    // One open request per requester and contact - asking again doesn't pile up duplicates.
    uniqueIndex('uq_family_link_requests_pending')
      .on(table.requesterUserId, table.targetContact)
      .where(sql`${table.status} = 'pending'`),
    index('idx_family_link_requests_requester').on(table.requesterUserId),
    index('idx_family_link_requests_primary_pending')
      .on(table.primaryContactUserId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

// ============================================================================
// notification_log
// ============================================================================

export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    type: text().notNull(),
    visitScheduleId: uuid().references(() => visitSchedules.id),
    audioRecordId: uuid().references(() => audioRecords.id),
    // NULL = every supervisor: a missed-visit alert is shared, any supervisor can acknowledge it
    // (0016). A cognitive_risk alert always names its family member.
    recipientUserId: uuid().references(() => users.id),
    channel: text(),
    sentAt: timestamp({ withTimezone: true }),
    acknowledgedAt: timestamp({ withTimezone: true }),
    acknowledgedBy: uuid().references(() => users.id),
  },
  (table) => [
    check('chk_notification_log_type', sql`${table.type} IN ('missed_visit', 'cognitive_risk')`),
    check(
      'chk_notification_log_related_entity',
      sql`(${table.type} = 'missed_visit' AND ${table.visitScheduleId} IS NOT NULL AND ${table.audioRecordId} IS NULL) OR
          (${table.type} = 'cognitive_risk' AND ${table.audioRecordId} IS NOT NULL AND ${table.visitScheduleId} IS NULL)`,
    ),
    check(
      'chk_notification_log_recipient',
      sql`${table.recipientUserId} IS NOT NULL OR ${table.type} = 'missed_visit'`,
    ),
    // One alert per missed visit, so re-running the sweep never raises a second.
    uniqueIndex('uq_notification_log_missed_visit')
      .on(table.visitScheduleId)
      .where(sql`${table.type} = 'missed_visit'`),
    index('idx_notification_log_recipient_sent').on(table.recipientUserId, table.sentAt),
    index('idx_notification_log_visit_schedule').on(table.visitScheduleId),
    index('idx_notification_log_audio_record').on(table.audioRecordId),
    index('idx_notification_log_acknowledged_by').on(table.acknowledgedBy),
  ],
);

// ============================================================================
// audit_log (append-only, generic across every entity type in the system)
// ============================================================================

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    actorUserId: uuid().references(() => users.id),
    action: text().notNull(),
    entityType: text().notNull(),
    // No FK: can point at any entity type in the system, not just two - see schema.sql's file header.
    // Nullable (0016) for actions with no single entity, e.g. a compliance export of a whole period.
    entityId: uuid(),
    metadata: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_audit_log_entity').on(table.entityType, table.entityId),
    index('idx_audit_log_actor_time').on(table.actorUserId, table.createdAt),
    // The audit log screen: newest first across every entity.
    index('idx_audit_log_created').on(table.createdAt, table.id),
    // `trg_audit_log_append_only` (rejects UPDATE/DELETE) is added by HEZ-9.
  ],
);

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
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ============================================================================
// Enum types
// ============================================================================

export const subjectTypeEnum = pgEnum('subject_type', ['caregiver', 'dependant']);
export const dependantStatusEnum = pgEnum('dependant_status', ['active', 'deactivated']);
export const dependantGenderEnum = pgEnum('dependant_gender', ['male', 'female']);
export const verificationAttemptTypeEnum = pgEnum('verification_attempt_type', [
  'geofence',
  'caregiver_liveness',
  'dependant_liveness',
]);
export const consentTypeEnum = pgEnum('consent_type', [
  'biometric_verification',
  'audio_cognitive_monitoring',
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
    index('idx_users_role').on(table.role),
  ],
);

// ============================================================================
// caregivers (1:1 extension of users)
// ============================================================================

export const caregivers = pgTable('caregivers', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id),
  employeeNumber: text().unique('uq_caregivers_employee_number'),
  hireDate: date(),
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
    gender: dependantGenderEnum(),
    homeAddressText: text(),
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
    caregiverMatchConfidence: numeric({ precision: 5, scale: 2 }),
    dependantMatchConfidence: numeric({ precision: 5, scale: 2 }),
    caregiverLivenessPassed: boolean(),
    dependantLivenessPassed: boolean(),
    // Hash of the short-lived session token, not the token itself (see schema.sql's file header).
    sessionTokenHash: text(),
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
    recipientUserId: uuid()
      .notNull()
      .references(() => users.id),
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
    entityId: uuid().notNull(),
    metadata: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_audit_log_entity').on(table.entityType, table.entityId),
    index('idx_audit_log_actor_time').on(table.actorUserId, table.createdAt),
    // `trg_audit_log_append_only` (rejects UPDATE/DELETE) is added by HEZ-9.
  ],
);

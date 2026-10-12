// Drizzle schema. Columns are camelCase here and snake_case in the DB (`casing` option).
//
// Things Drizzle can't express live in the hand-written migrations drizzle/0000 and 0002:
//   - uuid_generate_v7(), set_updated_at(), forbid_update_delete() and their extensions.
//   - The trg_*_updated_at triggers that keep `updatedAt` current.
//   - The append-only triggers on verification_attempts and audit_log.
//   - The EXCLUDE USING gist constraints on visit_schedules.

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

// Enum types

export const subjectTypeEnum = pgEnum('subject_type', ['caregiver', 'dependant']);
export const dependantStatusEnum = pgEnum('dependant_status', ['active', 'deactivated']);
export const dependantGenderEnum = pgEnum('dependant_gender', ['male', 'female']);
export const biometricEnrollmentStatusEnum = pgEnum('biometric_enrollment_status', [
  'active',
  'superseded',
  'deleted',
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

// users

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

// caregivers (1:1 extension of users)

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

// dependants

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

// dependant_family_members

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

// biometric_enrollments

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
    status: biometricEnrollmentStatusEnum().notNull().default('active'),
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
    index('idx_biometric_enrollments_caregiver_active').on(table.caregiverId, table.status),
    index('idx_biometric_enrollments_dependant_active').on(table.dependantId, table.status),
    index('idx_biometric_enrollments_enrolled_by').on(table.enrolledBy),
  ],
);

// visit_schedules

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
    // Double-booking EXCLUDE constraints are in the custom migration.
  ],
);

// verification_events

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

// verification_attempts (append-only audit trail)

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
    // Append-only trigger is in the custom migration.
  ],
);

// audio_records

export const audioRecords = pgTable(
  'audio_records',
  {
    id: uuid()
      .primaryKey()
      .default(sql`uuid_generate_v7()`),
    // FK is declared below with a short name; the default exceeds Postgres's 63-byte limit.
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

// consent_records

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

// notification_log

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

// audit_log (append-only, generic across every entity type in the system)

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
    // Append-only trigger is in the custom migration.
  ],
);

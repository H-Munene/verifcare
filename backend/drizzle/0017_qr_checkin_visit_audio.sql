-- QR check-in and family-audible visit audio replace face matching and cognitive monitoring
-- (2026-11-09). Hand-written like 0010-0016 (see 0011's header).
--
-- Why: facial biometrics were judged too invasive for what they add, so check-in now proves presence
-- with a short-lived code shown on a family member's phone at the home. The acoustic model will not
-- run in the system, so visit audio changes purpose: a 30-second recording the dependant's family
-- can listen to.
--
-- 1. Everything biometric goes (table, match scores, attempt rows that held photo keys and face
--    similarity), rather than being left unused: keeping it would undercut the reason for the
--    change. Old consent rows are deleted because they consented to purposes that no longer exist;
--    terms v3 asks for consent to the new ones.
-- 2. verification_attempts is append-only, so its trigger is disabled just long enough to remove
--    the face-match attempts. Deployed databases hold none of this data; the delete covers
--    developers' local databases.
-- 3. notification_log loses cognitive_risk and gains checkin_override, a shared supervisor alert.

ALTER TABLE "verification_attempts" DISABLE TRIGGER "trg_verification_attempts_append_only";
--> statement-breakpoint
DELETE FROM "verification_attempts" WHERE "attempt_type" IN ('caregiver_liveness', 'dependant_liveness');
--> statement-breakpoint
ALTER TABLE "verification_attempts" ENABLE TRIGGER "trg_verification_attempts_append_only";
--> statement-breakpoint
ALTER TYPE "verification_attempt_type" RENAME TO "verification_attempt_type_old";
--> statement-breakpoint
CREATE TYPE "verification_attempt_type" AS ENUM('geofence', 'family_location', 'qr_scan');
--> statement-breakpoint
ALTER TABLE "verification_attempts" ALTER COLUMN "attempt_type" TYPE "verification_attempt_type" USING "attempt_type"::text::"verification_attempt_type";
--> statement-breakpoint
DROP TYPE "verification_attempt_type_old";
--> statement-breakpoint

DELETE FROM "consent_records";
--> statement-breakpoint
ALTER TYPE "consent_type" RENAME TO "consent_type_old";
--> statement-breakpoint
CREATE TYPE "consent_type" AS ENUM('location_verification', 'visit_audio');
--> statement-breakpoint
ALTER TABLE "consent_records" ALTER COLUMN "consent_type" TYPE "consent_type" USING "consent_type"::text::"consent_type";
--> statement-breakpoint
DROP TYPE "consent_type_old";
--> statement-breakpoint

DROP TABLE "biometric_enrollments" CASCADE;
--> statement-breakpoint
ALTER TABLE "dependants" DROP COLUMN "cognitive_monitoring_enabled";
--> statement-breakpoint

ALTER TABLE "terms_acceptances" DROP COLUMN "biometric_consent";
--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD COLUMN "location_consent" boolean;
--> statement-breakpoint

ALTER TABLE "verification_events" DROP CONSTRAINT IF EXISTS "chk_verification_events_caregiver_match_confidence_range";
--> statement-breakpoint
ALTER TABLE "verification_events" DROP CONSTRAINT IF EXISTS "chk_verification_events_dependant_match_confidence_range";
--> statement-breakpoint
ALTER TABLE "verification_events" DROP COLUMN "caregiver_match_confidence";
--> statement-breakpoint
ALTER TABLE "verification_events" DROP COLUMN "dependant_match_confidence";
--> statement-breakpoint
ALTER TABLE "verification_events" DROP COLUMN "caregiver_liveness_passed";
--> statement-breakpoint
ALTER TABLE "verification_events" DROP COLUMN "dependant_liveness_passed";
--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "checkin_method" text;
--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "qr_family_member_user_id" uuid REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "family_distance_from_geofence_meters" double precision;
--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "audio_skip_reason" text;
--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "audio_skip_note" text;
--> statement-breakpoint
ALTER TABLE "verification_events" ADD CONSTRAINT "chk_verification_events_checkin_method" CHECK ("checkin_method" IS NULL OR "checkin_method" IN ('qr', 'supervisor_override'));
--> statement-breakpoint
ALTER TABLE "verification_events" ADD CONSTRAINT "chk_verification_events_audio_skip_reason" CHECK ("audio_skip_reason" IS NULL OR "audio_skip_reason" IN ('dependant_declined', 'dependant_unwell_or_asleep', 'technical_problem', 'other'));
--> statement-breakpoint
ALTER TABLE "verification_events" ADD CONSTRAINT "chk_verification_events_audio_skip_other_note" CHECK ("audio_skip_reason" IS DISTINCT FROM 'other' OR length(btrim(coalesce("audio_skip_note", ''))) > 0);
--> statement-breakpoint

DELETE FROM "notification_log" WHERE "type" = 'cognitive_risk';
--> statement-breakpoint
ALTER TABLE "notification_log" DROP CONSTRAINT "chk_notification_log_type";
--> statement-breakpoint
ALTER TABLE "notification_log" DROP CONSTRAINT "chk_notification_log_related_entity";
--> statement-breakpoint
ALTER TABLE "notification_log" DROP CONSTRAINT "chk_notification_log_recipient";
--> statement-breakpoint
ALTER TABLE "notification_log" DROP COLUMN "audio_record_id";
--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "chk_notification_log_type" CHECK ("type" IN ('missed_visit', 'checkin_override'));
--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "chk_notification_log_related_entity" CHECK ("visit_schedule_id" IS NOT NULL);
--> statement-breakpoint

DELETE FROM "audio_records";
--> statement-breakpoint
ALTER TABLE "audio_records" DROP CONSTRAINT IF EXISTS "chk_audio_records_risk_score_range";
--> statement-breakpoint
ALTER TABLE "audio_records" DROP COLUMN "risk_score";
--> statement-breakpoint
ALTER TABLE "audio_records" DROP COLUMN "model_version";
--> statement-breakpoint
ALTER TABLE "audio_records" DROP COLUMN "processed_at";
--> statement-breakpoint
ALTER TABLE "audio_records" ALTER COLUMN "duration_seconds" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "audio_records" ADD COLUMN "uploaded_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
DROP INDEX "idx_audio_records_verification_event";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_audio_records_verification_event" ON "audio_records" USING btree ("verification_event_id");
--> statement-breakpoint

CREATE TABLE "checkin_qr_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"visit_schedule_id" uuid NOT NULL REFERENCES "visit_schedules"("id"),
	"family_member_user_id" uuid NOT NULL REFERENCES "users"("id"),
	"token_hash" text NOT NULL,
	"distance_from_geofence_meters" double precision NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "uq_checkin_qr_tokens_token_hash" UNIQUE("token_hash"),
	CONSTRAINT "chk_checkin_qr_tokens_expiry" CHECK ("expires_at" > "issued_at")
);
--> statement-breakpoint
CREATE INDEX "idx_checkin_qr_tokens_visit" ON "checkin_qr_tokens" USING btree ("visit_schedule_id");
--> statement-breakpoint
CREATE INDEX "idx_checkin_qr_tokens_family_member" ON "checkin_qr_tokens" USING btree ("family_member_user_id");
--> statement-breakpoint

CREATE TABLE "checkin_override_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"visit_schedule_id" uuid NOT NULL REFERENCES "visit_schedules"("id"),
	"requested_by" uuid NOT NULL REFERENCES "users"("id"),
	"reason" text NOT NULL,
	"note" text,
	"distance_from_geofence_meters" double precision NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid REFERENCES "users"("id"),
	"decision_note" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "chk_checkin_override_requests_reason" CHECK ("reason" IN ('no_family_member_present', 'family_phone_unavailable', 'network_problem', 'other')),
	CONSTRAINT "chk_checkin_override_requests_status" CHECK ("status" IN ('pending', 'approved', 'denied')),
	CONSTRAINT "chk_checkin_override_requests_other_note" CHECK ("reason" != 'other' OR length(btrim(coalesce("note", ''))) > 0),
	CONSTRAINT "chk_checkin_override_requests_decision" CHECK (("status" = 'pending' AND "decided_by" IS NULL AND "decided_at" IS NULL) OR ("status" != 'pending' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND length(btrim(coalesce("decision_note", ''))) > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_checkin_override_requests_pending" ON "checkin_override_requests" USING btree ("visit_schedule_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX "idx_checkin_override_requests_visit" ON "checkin_override_requests" USING btree ("visit_schedule_id", "requested_at");
--> statement-breakpoint
CREATE INDEX "idx_checkin_override_requests_requested_by" ON "checkin_override_requests" USING btree ("requested_by");
--> statement-breakpoint
CREATE INDEX "idx_checkin_override_requests_decided_by" ON "checkin_override_requests" USING btree ("decided_by");

-- Voice-verified visits and family-confirmed check-out (2026-11-13). Hand-written like 0010-0018.
--
-- 1. A visit has two recordings, the caregiver's and the dependant's. The single family recording
--    becomes the dependant's, which the family still plays.
-- 2. Each recording is checked against an enrolled voiceprint. Results are advisory and never block.
-- 3. Check-out is confirmed by a family member's QR code or 6-digit code, or overridden with a
--    reason. An override completes at once and is reviewed afterwards.

ALTER TYPE "consent_type" ADD VALUE 'voice_verification';
--> statement-breakpoint
ALTER TYPE "verification_attempt_type" ADD VALUE 'checkout_qr';
--> statement-breakpoint
ALTER TYPE "verification_attempt_type" ADD VALUE 'checkout_code';
--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD COLUMN "voice_consent" boolean;
--> statement-breakpoint

ALTER TABLE "audio_records" ADD COLUMN "role" text DEFAULT 'dependant' NOT NULL;
--> statement-breakpoint
ALTER TABLE "audio_records" ALTER COLUMN "role" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "audio_records" ADD CONSTRAINT "chk_audio_records_role" CHECK ("role" IN ('caregiver', 'dependant'));
--> statement-breakpoint
DROP INDEX "uq_audio_records_verification_event";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_audio_records_verification_event_role" ON "audio_records" USING btree ("verification_event_id", "role");
--> statement-breakpoint

CREATE TABLE "voice_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"subject_type" "subject_type" NOT NULL,
	"caregiver_id" uuid REFERENCES "caregivers"("user_id"),
	"dependant_id" uuid REFERENCES "dependants"("id"),
	"voiceprint_key" text NOT NULL,
	"speech_seconds" double precision NOT NULL,
	"model_revision" text NOT NULL,
	"enrolled_by" uuid NOT NULL REFERENCES "users"("id"),
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "uq_voice_enrollments_voiceprint_key" UNIQUE("voiceprint_key"),
	CONSTRAINT "chk_voice_enrollments_subject" CHECK (("subject_type" = 'caregiver' AND "caregiver_id" IS NOT NULL AND "dependant_id" IS NULL) OR ("subject_type" = 'dependant' AND "dependant_id" IS NOT NULL AND "caregiver_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_voice_enrollments_active_caregiver" ON "voice_enrollments" USING btree ("caregiver_id") WHERE "removed_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_voice_enrollments_active_dependant" ON "voice_enrollments" USING btree ("dependant_id") WHERE "removed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_voice_enrollments_enrolled_by" ON "voice_enrollments" USING btree ("enrolled_by");
--> statement-breakpoint

CREATE TABLE "voice_checks" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"audio_record_id" uuid NOT NULL REFERENCES "audio_records"("id"),
	"result" text NOT NULL,
	"score" double precision,
	"speech_seconds" double precision,
	"threshold" double precision,
	"model_revision" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_voice_checks_audio_record" UNIQUE("audio_record_id"),
	CONSTRAINT "chk_voice_checks_result" CHECK ("result" IN ('match', 'mismatch', 'too_short', 'not_enrolled', 'no_consent', 'unavailable')),
	CONSTRAINT "chk_voice_checks_score" CHECK (("result" IN ('match', 'mismatch')) = ("score" IS NOT NULL))
);
--> statement-breakpoint

ALTER TABLE "verification_events" ADD COLUMN "checkout_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "checkout_method" text;
--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "checkout_family_member_user_id" uuid REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "checkout_family_distance_meters" double precision;
--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "checkout_override_reason" text;
--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "checkout_override_note" text;
--> statement-breakpoint
ALTER TABLE "verification_events" ADD CONSTRAINT "chk_verification_events_checkout_method" CHECK ("checkout_method" IS NULL OR "checkout_method" IN ('qr', 'code', 'override'));
--> statement-breakpoint
ALTER TABLE "verification_events" ADD CONSTRAINT "chk_verification_events_checkout_override_reason" CHECK ("checkout_override_reason" IS NULL OR ("checkout_method" = 'override' AND "checkout_override_reason" IN ('no_family_member_present', 'family_phone_unavailable', 'camera_or_code_problem', 'other')));
--> statement-breakpoint
ALTER TABLE "verification_events" ADD CONSTRAINT "chk_verification_events_checkout_override_other_note" CHECK ("checkout_override_reason" IS DISTINCT FROM 'other' OR length(btrim(coalesce("checkout_override_note", ''))) > 0);
--> statement-breakpoint

ALTER TABLE "checkin_qr_tokens" ADD COLUMN "purpose" text DEFAULT 'checkin' NOT NULL;
--> statement-breakpoint
ALTER TABLE "checkin_qr_tokens" ADD COLUMN "code_hash" text;
--> statement-breakpoint
ALTER TABLE "checkin_qr_tokens" ADD CONSTRAINT "chk_checkin_qr_tokens_purpose" CHECK ("purpose" IN ('checkin', 'checkout'));
--> statement-breakpoint
CREATE INDEX "idx_checkin_qr_tokens_visit_code" ON "checkin_qr_tokens" USING btree ("visit_schedule_id", "code_hash") WHERE "code_hash" IS NOT NULL;

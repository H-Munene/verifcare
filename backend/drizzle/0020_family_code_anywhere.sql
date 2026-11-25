-- Family codes from anywhere (2026-11-25). Hand-written like 0010-0019.
--
-- 1. A family member's phone no longer has to be at the home to show a code, so a code row may
--    have no distance. Existing rows keep theirs.
-- 2. Check-in codes carry 6 digits too, typed in by the caregiver as checkin_code attempts, and a
--    visit started that way records checkin_method 'code'.

ALTER TYPE "verification_attempt_type" ADD VALUE 'checkin_code';
--> statement-breakpoint
ALTER TABLE "checkin_qr_tokens" ALTER COLUMN "distance_from_geofence_meters" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "verification_events" DROP CONSTRAINT "chk_verification_events_checkin_method";
--> statement-breakpoint
ALTER TABLE "verification_events" ADD CONSTRAINT "chk_verification_events_checkin_method" CHECK ("verification_events"."checkin_method" IS NULL OR "verification_events"."checkin_method" IN ('qr', 'code', 'supervisor_override'));

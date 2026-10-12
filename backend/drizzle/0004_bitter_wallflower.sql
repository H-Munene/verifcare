ALTER TABLE "verification_events" ADD COLUMN "pending_challenge_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "pending_challenge_type" text;--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "pending_challenge_subject" text;--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "pending_challenge_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verification_events" ADD CONSTRAINT "chk_verification_events_pending_challenge_type" CHECK ("verification_events"."pending_challenge_type" IS NULL OR "verification_events"."pending_challenge_type" IN ('turn_head_left_then_right', 'blink_twice'));--> statement-breakpoint
ALTER TABLE "verification_events" ADD CONSTRAINT "chk_verification_events_pending_challenge_subject" CHECK ("verification_events"."pending_challenge_subject" IS NULL OR "verification_events"."pending_challenge_subject" IN ('caregiver', 'dependant'));
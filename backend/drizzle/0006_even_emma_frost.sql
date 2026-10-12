ALTER TABLE "verification_events" DROP CONSTRAINT "chk_verification_events_pending_challenge_type";--> statement-breakpoint
ALTER TABLE "verification_events" DROP CONSTRAINT "chk_verification_events_pending_challenge_subject";--> statement-breakpoint
ALTER TABLE "verification_events" DROP COLUMN "pending_challenge_id";--> statement-breakpoint
ALTER TABLE "verification_events" DROP COLUMN "pending_challenge_type";--> statement-breakpoint
ALTER TABLE "verification_events" DROP COLUMN "pending_challenge_subject";--> statement-breakpoint
ALTER TABLE "verification_events" DROP COLUMN "pending_challenge_expires_at";
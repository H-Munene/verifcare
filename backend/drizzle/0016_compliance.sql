-- Compliance foundations (2026-09-27, the supervisor console's Compliance tab). Hand-written like
-- 0010-0015 (see 0011's header). Each change exists because a Compliance report had no data
-- source without it:
--
-- 1. notification_log.recipient_user_id nullable: the missed-visit sweep now raises one shared
--    alert per missed visit that any supervisor can acknowledge (the product owner's choice over
--    one alert per supervisor), so a missed_visit alert has no single recipient. NULL means "all
--    supervisors" and is allowed only for missed_visit; a cognitive_risk alert still names its
--    family member. The unique partial index makes the sweep idempotent: re-running it can never
--    raise a second alert for the same visit.
-- 2. visit_resolutions: who resolved a missed visit or a failed check, with what outcome and why.
--    Nothing recorded this before. Append-only like audit_log: a later resolution supersedes an
--    earlier one instead of rewriting it, so the history an auditor sees is never altered.
-- 3. consent_records.revoked_by: the consent register has to show who revoked a consent, not
--    just when (Kenya DPA s.32(1) puts the burden of proving consent on the controller).
-- 4. audit_log.entity_id nullable: some audited actions have no single entity (a compliance CSV
--    export covers a whole period), and inventing an id for them would mislead.
-- 5. audit_log (created_at, id) index: the audit log screen lists newest first across every
--    entity, which neither existing index serves.

ALTER TABLE "notification_log" ALTER COLUMN "recipient_user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "chk_notification_log_recipient" CHECK ("notification_log"."recipient_user_id" IS NOT NULL OR "notification_log"."type" = 'missed_visit');
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notification_log_missed_visit" ON "notification_log" USING btree ("visit_schedule_id") WHERE "notification_log"."type" = 'missed_visit';
--> statement-breakpoint

CREATE TABLE "visit_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"visit_schedule_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"note" text NOT NULL,
	"resolved_by" uuid NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_visit_resolutions_outcome" CHECK ("visit_resolutions"."outcome" IN ('caregiver_absent', 'family_cancelled', 'dependant_unavailable', 'device_or_network_issue', 'visit_took_place', 'verified_manually', 'other')),
	CONSTRAINT "chk_visit_resolutions_note" CHECK (length(btrim("visit_resolutions"."note")) > 0)
);
--> statement-breakpoint
ALTER TABLE "visit_resolutions" ADD CONSTRAINT "visit_resolutions_visit_schedule_id_visit_schedules_id_fk" FOREIGN KEY ("visit_schedule_id") REFERENCES "public"."visit_schedules"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "visit_resolutions" ADD CONSTRAINT "visit_resolutions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_visit_resolutions_visit" ON "visit_resolutions" USING btree ("visit_schedule_id","resolved_at");
--> statement-breakpoint
CREATE TRIGGER trg_visit_resolutions_append_only
    BEFORE UPDATE OR DELETE ON visit_resolutions
    FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint

ALTER TABLE "consent_records" ADD COLUMN "revoked_by" uuid;
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "audit_log" ALTER COLUMN "entity_id" DROP NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_audit_log_created" ON "audit_log" USING btree ("created_at","id");

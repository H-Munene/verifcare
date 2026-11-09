-- Day planning and automatic missed-visit recovery (2026-11-09). Hand-written like 0010-0017.
--
-- 1. caregivers' home base: where a route starts, and the fallback for "nearest" when a caregiver
--    hasn't checked in anywhere today. An area rather than live tracking, deliberately.
-- 2. visit_plans / visit_plan_clusters: a draft a supervisor reviews before any visit exists.
-- 3. A 'reassigned' visit status, excluded from both overlap constraints. Without it a replacement
--    visit in the same window would be refused, because the original would still occupy it.
-- 4. visit_recovery_cases / visit_recovery_offers: one case per late visit, one live offer at a
--    time, each caregiver offered at most once.

ALTER TABLE "caregivers" ADD COLUMN "base_lat" double precision;
--> statement-breakpoint
ALTER TABLE "caregivers" ADD COLUMN "base_lng" double precision;
--> statement-breakpoint
ALTER TABLE "caregivers" ADD COLUMN "base_area_text" text;
--> statement-breakpoint
ALTER TABLE "caregivers" ADD CONSTRAINT "chk_caregivers_base_together" CHECK (("base_lat" IS NULL) = ("base_lng" IS NULL));
--> statement-breakpoint

CREATE TABLE "visit_plans" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"plan_date" date NOT NULL,
	"shift_start" text NOT NULL,
	"shift_end" text NOT NULL,
	"visit_minutes" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"unplaced" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_caregivers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "chk_visit_plans_status" CHECK ("status" IN ('draft', 'published')),
	CONSTRAINT "chk_visit_plans_visit_minutes" CHECK ("visit_minutes" > 0)
);
--> statement-breakpoint
CREATE INDEX "idx_visit_plans_date" ON "visit_plans" USING btree ("plan_date");
--> statement-breakpoint

CREATE TABLE "visit_plan_clusters" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"plan_id" uuid NOT NULL REFERENCES "visit_plans"("id"),
	"caregiver_id" uuid NOT NULL REFERENCES "caregivers"("user_id"),
	"stops" jsonb NOT NULL,
	"total_distance_meters" double precision NOT NULL,
	"total_travel_minutes" integer NOT NULL,
	CONSTRAINT "uq_visit_plan_clusters_plan_caregiver" UNIQUE("plan_id", "caregiver_id")
);
--> statement-breakpoint

ALTER TABLE "visit_schedules" ADD COLUMN "plan_cluster_id" uuid REFERENCES "visit_plan_clusters"("id");
--> statement-breakpoint
ALTER TABLE "visit_schedules" ADD COLUMN "route_sequence" smallint;
--> statement-breakpoint
ALTER TABLE "visit_schedules" ADD COLUMN "recovered_from_visit_id" uuid REFERENCES "visit_schedules"("id");
--> statement-breakpoint
ALTER TABLE "visit_schedules" DROP CONSTRAINT "chk_visit_schedules_status";
--> statement-breakpoint
ALTER TABLE "visit_schedules" ADD CONSTRAINT "chk_visit_schedules_status" CHECK ("status" IN ('scheduled', 'in_progress', 'completed', 'missed', 'cancelled', 'investigated', 'reassigned'));
--> statement-breakpoint
ALTER TABLE "visit_schedules" DROP CONSTRAINT "excl_visit_schedules_caregiver_overlap";
--> statement-breakpoint
ALTER TABLE "visit_schedules" DROP CONSTRAINT "excl_visit_schedules_dependant_overlap";
--> statement-breakpoint
ALTER TABLE "visit_schedules" ADD CONSTRAINT "excl_visit_schedules_caregiver_overlap"
    EXCLUDE USING gist (caregiver_id WITH =, tstzrange(scheduled_start, scheduled_end) WITH &&)
    WHERE (status NOT IN ('cancelled', 'reassigned'));
--> statement-breakpoint
ALTER TABLE "visit_schedules" ADD CONSTRAINT "excl_visit_schedules_dependant_overlap"
    EXCLUDE USING gist (dependant_id WITH =, tstzrange(scheduled_start, scheduled_end) WITH &&)
    WHERE (status NOT IN ('cancelled', 'reassigned'));
--> statement-breakpoint

CREATE TABLE "visit_recovery_cases" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"visit_schedule_id" uuid NOT NULL REFERENCES "visit_schedules"("id"),
	"status" text DEFAULT 'open' NOT NULL,
	"replacement_visit_id" uuid REFERENCES "visit_schedules"("id"),
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "uq_visit_recovery_cases_visit" UNIQUE("visit_schedule_id"),
	CONSTRAINT "chk_visit_recovery_cases_status" CHECK ("status" IN ('open', 'recovered', 'exhausted', 'closed'))
);
--> statement-breakpoint
CREATE INDEX "idx_visit_recovery_cases_status" ON "visit_recovery_cases" USING btree ("status");
--> statement-breakpoint

CREATE TABLE "visit_recovery_offers" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"case_id" uuid NOT NULL REFERENCES "visit_recovery_cases"("id"),
	"caregiver_id" uuid NOT NULL REFERENCES "caregivers"("user_id"),
	"rank" smallint NOT NULL,
	"distance_meters" double precision NOT NULL,
	"proposed_start" timestamp with time zone NOT NULL,
	"proposed_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'offered' NOT NULL,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "uq_visit_recovery_offers_case_caregiver" UNIQUE("case_id", "caregiver_id"),
	CONSTRAINT "chk_visit_recovery_offers_status" CHECK ("status" IN ('offered', 'accepted', 'declined', 'expired', 'withdrawn'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_visit_recovery_offers_live" ON "visit_recovery_offers" USING btree ("case_id") WHERE "status" = 'offered';
--> statement-breakpoint
CREATE INDEX "idx_visit_recovery_offers_caregiver" ON "visit_recovery_offers" USING btree ("caregiver_id", "status");
--> statement-breakpoint

ALTER TABLE "notification_log" DROP CONSTRAINT "chk_notification_log_type";
--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "chk_notification_log_type" CHECK ("type" IN ('missed_visit', 'checkin_override', 'no_cover_found'));

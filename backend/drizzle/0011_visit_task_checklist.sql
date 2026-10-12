-- Visit task checklist (docs/visit-task-checklist-plan.md): dependant_care_tasks (the care plan,
-- authored by a supervisor) and visit_task_completions (filled in live during a visit). Hand-written,
-- not drizzle-kit generated - `drizzle-kit generate` invokes an interactive enum-resolution prompt
-- in this non-interactive environment even for a plain new-enum addition (no rename involved), the
-- same class of problem 0010's own header notes for its enum rename. Matches 0010's own precedent:
-- the SQL is hand-written and applied directly; the drizzle-kit snapshot history already drifted out
-- of sync as of 0010 (meta/0010_snapshot.json still shows the pre-rename "dependant_gender" enum
-- name, confirmed by inspection, not assumed) and this migration doesn't attempt to repair that -
-- `drizzle-kit generate` isn't usable non-interactively in this environment regardless, so a
-- perfectly current snapshot wouldn't restore that anyway. A future schema change should expect to
-- hand-write its migration too, or have the user run `drizzle-kit generate` themselves on a real
-- interactive terminal.

CREATE TYPE "task_completion_status" AS ENUM ('completed', 'not_completed', 'not_applicable');
--> statement-breakpoint

CREATE TYPE "task_skip_reason" AS ENUM ('client_declined', 'client_unavailable', 'equipment_unavailable', 'other');
--> statement-breakpoint

CREATE TABLE "dependant_care_tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"dependant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text,
	"required" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "visit_task_completions" (
	"visit_schedule_id" uuid NOT NULL,
	"care_task_id" uuid NOT NULL,
	"status" "task_completion_status" NOT NULL,
	"reason" "task_skip_reason",
	"notes" text,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visit_task_completions_visit_schedule_id_care_task_id_pk" PRIMARY KEY("visit_schedule_id","care_task_id")
);
--> statement-breakpoint

ALTER TABLE "dependant_care_tasks" ADD CONSTRAINT "dependant_care_tasks_dependant_id_dependants_id_fk" FOREIGN KEY ("dependant_id") REFERENCES "public"."dependants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "dependant_care_tasks" ADD CONSTRAINT "dependant_care_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "visit_task_completions" ADD CONSTRAINT "visit_task_completions_visit_schedule_id_visit_schedules_id_fk" FOREIGN KEY ("visit_schedule_id") REFERENCES "public"."visit_schedules"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "visit_task_completions" ADD CONSTRAINT "visit_task_completions_care_task_id_dependant_care_tasks_id_fk" FOREIGN KEY ("care_task_id") REFERENCES "public"."dependant_care_tasks"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "visit_task_completions" ADD CONSTRAINT "chk_visit_task_completions_reason" CHECK (("visit_task_completions"."status" = 'not_completed' AND "visit_task_completions"."reason" IS NOT NULL) OR ("visit_task_completions"."status" != 'not_completed' AND "visit_task_completions"."reason" IS NULL));
--> statement-breakpoint

CREATE INDEX "idx_dependant_care_tasks_dependant_active" ON "dependant_care_tasks" USING btree ("dependant_id","active");
--> statement-breakpoint

CREATE INDEX "idx_visit_task_completions_visit" ON "visit_task_completions" USING btree ("visit_schedule_id");
--> statement-breakpoint

CREATE TRIGGER trg_dependant_care_tasks_updated_at
    BEFORE UPDATE ON dependant_care_tasks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

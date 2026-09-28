-- family_link_requests (2026-09-26): a family member asking a dependant's primary contact to link
-- them, approved or rejected by the primary contact in the family app. Hand-written like 0010-0012
-- (see 0011's header). See schema.ts for why the target is stored as the typed contact and only
-- resolved to a user when it belongs to a primary contact.

CREATE TABLE "family_link_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"target_contact" text NOT NULL,
	"primary_contact_user_id" uuid,
	"relationship" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"linked_dependant_ids" uuid[],
	"decided_at" timestamp with time zone,
	"requester_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_family_link_requests_status" CHECK ("family_link_requests"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "chk_family_link_requests_decision" CHECK (("family_link_requests"."status" = 'pending' AND "family_link_requests"."decided_at" IS NULL) OR
          ("family_link_requests"."status" = 'rejected' AND "family_link_requests"."decided_at" IS NOT NULL) OR
          ("family_link_requests"."status" = 'approved' AND "family_link_requests"."decided_at" IS NOT NULL AND "family_link_requests"."linked_dependant_ids" IS NOT NULL))
);
--> statement-breakpoint

ALTER TABLE "family_link_requests" ADD CONSTRAINT "family_link_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "family_link_requests" ADD CONSTRAINT "family_link_requests_primary_contact_user_id_users_id_fk" FOREIGN KEY ("primary_contact_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "uq_family_link_requests_pending" ON "family_link_requests" USING btree ("requester_user_id","target_contact") WHERE "family_link_requests"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX "idx_family_link_requests_requester" ON "family_link_requests" USING btree ("requester_user_id");
--> statement-breakpoint
CREATE INDEX "idx_family_link_requests_primary_pending" ON "family_link_requests" USING btree ("primary_contact_user_id") WHERE "family_link_requests"."status" = 'pending';
--> statement-breakpoint

CREATE TRIGGER trg_family_link_requests_updated_at
    BEFORE UPDATE ON family_link_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- terms_acceptances (2026-09-26): each user's acceptance of the mobile apps' terms of use and
-- privacy notice, one row per document version, so a new version asks everyone again while the
-- record of what each person agreed to is kept. Hand-written, like 0010 and 0011 (see 0011's
-- header: `drizzle-kit generate` can't run non-interactively in this environment).
--
-- Append-only by trigger, the same as verification_attempts and audit_log: an acceptance is a
-- compliance record under the Kenya Data Protection Act, so it must never be edited or removed
-- after the fact.

CREATE TABLE "terms_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"user_id" uuid NOT NULL,
	"document" text NOT NULL,
	"version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_terms_acceptances_user_document_version" UNIQUE("user_id","document","version"),
	CONSTRAINT "chk_terms_acceptances_document" CHECK ("terms_acceptances"."document" IN ('caregiver', 'family_member'))
);
--> statement-breakpoint

ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE TRIGGER trg_terms_acceptances_append_only
    BEFORE UPDATE OR DELETE ON terms_acceptances
    FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

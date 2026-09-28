-- terms_acceptances consent columns (2026-09-27): the consent screen now has two required
-- checkboxes (photo-based identity verification, and audio recording during visits), and the
-- acceptance records what was ticked. Hand-written like 0010-0013 (see 0011's header).
--
-- Nullable with no default: v1 acceptances never asked, so null ("not asked") is the honest value
-- for them, and adding a nullable column without a default rewrites no rows - the append-only
-- trigger (trg_terms_acceptances_append_only, a row-level BEFORE UPDATE OR DELETE trigger) is
-- untouched and never fires for ALTER TABLE.

ALTER TABLE "terms_acceptances" ADD COLUMN "biometric_consent" boolean;
--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD COLUMN "audio_consent" boolean;

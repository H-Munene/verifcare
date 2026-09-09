-- Hand-written (drizzle-kit generate --custom), not schema-diff-generated. Ported verbatim from
-- docs/schema.sql - see that file for the full design rationale. Must run after 0001 (the table
-- migration), since every statement here depends on tables (and 0000's functions) already existing.
-- None of this is representable in Drizzle's schema model (confirmed against the installed
-- drizzle-orm/pg-core: no exclude() export at all, and triggers aren't part of drizzle-kit's
-- generated-migration diffing), which is why it's hand-written here instead of in schema.ts.

-- ============================================================================
-- updated_at triggers
-- ============================================================================

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_caregivers_updated_at
    BEFORE UPDATE ON caregivers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_dependants_updated_at
    BEFORE UPDATE ON dependants
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_biometric_enrollments_updated_at
    BEFORE UPDATE ON biometric_enrollments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_visit_schedules_updated_at
    BEFORE UPDATE ON visit_schedules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ============================================================================
-- visit_schedules double-booking prevention
-- Prevents the same caregiver, or the same dependant, from being booked into two overlapping
-- time windows. Cancelled visits are excluded from this check (a cancelled slot is free to
-- rebook); every other status, including `missed`, still blocks double-booking.
-- ============================================================================

ALTER TABLE visit_schedules ADD CONSTRAINT excl_visit_schedules_caregiver_overlap
    EXCLUDE USING gist (caregiver_id WITH =, tstzrange(scheduled_start, scheduled_end) WITH &&)
    WHERE (status <> 'cancelled');
--> statement-breakpoint
ALTER TABLE visit_schedules ADD CONSTRAINT excl_visit_schedules_dependant_overlap
    EXCLUDE USING gist (dependant_id WITH =, tstzrange(scheduled_start, scheduled_end) WITH &&)
    WHERE (status <> 'cancelled');
--> statement-breakpoint

-- ============================================================================
-- Append-only enforcement
-- ============================================================================

CREATE TRIGGER trg_verification_attempts_append_only
    BEFORE UPDATE OR DELETE ON verification_attempts
    FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
--> statement-breakpoint
CREATE TRIGGER trg_audit_log_append_only
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

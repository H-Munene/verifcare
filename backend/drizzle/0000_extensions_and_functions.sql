-- Hand-written (drizzle-kit generate --custom), not schema-diff-generated. Ported verbatim from
-- docs/schema.sql's "Extensions & helper functions" section - see that file for the full design
-- rationale. Must run before 0001 (the table migration), since uuid_generate_v7() is referenced
-- as a column default on every table.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
-- Lets a GiST index (used by the EXCLUDE constraints in 0002) handle plain equality on scalar
-- types like uuid, alongside the range-overlap operator.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
-- Generates an RFC 9562 UUID version 7 (time-ordered) value.
-- Postgres 18+ ships a native uuidv7() builtin that can replace this once the RDS instance
-- is upgraded past that version; kept as a portable plpgsql implementation until then.
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    unix_ts_ms bytea;
    uuid_bytes bytea;
BEGIN
    unix_ts_ms = substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
    uuid_bytes = unix_ts_ms || gen_random_bytes(10);

    -- Set version nibble (0111 = 7) in byte 6.
    uuid_bytes = set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
    -- Set RFC 4122 variant bits (10) in byte 8.
    uuid_bytes = set_byte(uuid_bytes, 8, (b'10' || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);

    RETURN encode(uuid_bytes, 'hex')::uuid;
END;
$$;
--> statement-breakpoint
-- Keeps `updated_at` correct without relying on every call site to set it. Attached to tables by
-- the trg_*_updated_at triggers in 0002.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Enforces append-only tables at the database level. Attached to tables by the
-- trg_*_append_only triggers in 0002.
CREATE OR REPLACE FUNCTION forbid_update_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$;

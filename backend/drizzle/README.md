# Migrations

This folder is generated and hand-written `drizzle-kit` output for the `mzazi_care_dev` /
production Postgres schema.
`../src/db/schema.ts` is the source of truth for every table, enum, index, and CHECK constraint -
running `npm run db:generate` diffs it and adds a new migration here automatically.

## Objects that live outside `schema.ts`

Some database objects aren't representable in Drizzle's schema model at all, so they were never
written in `schema.ts` and will never show up in a `db:generate` diff.
They're hand-written directly into migration files instead, via `npm run db:generate:custom`.
If `schema.ts` is ever rewritten from scratch, or ported to a different ORM, these are the objects
that need to be deliberately re-added - nothing will warn you if they're silently dropped.

They're ported verbatim from `../../docs/schema.sql`, which remains the canonical description of
the full schema (application-level tables included); this file only covers the part `schema.ts`
can't express.

### `0000_extensions_and_functions.sql`

Runs before any table exists, since `uuid_generate_v7()` is referenced as a column default on
every table.

- **Extensions**: `pgcrypto` (used by `uuid_generate_v7()`) and `btree_gist` (lets the `EXCLUDE`
  constraints below combine equality on a `uuid` column with a range-overlap check in one GiST
  index).
- **`uuid_generate_v7()`**: generates an RFC 9562 UUID v7 (time-ordered) value, used as the
  `DEFAULT` on every table's primary key. A portable plpgsql implementation, since the RDS
  instance isn't yet on Postgres 18+ (which ships a native `uuidv7()` builtin that could replace
  this later).
- **`set_updated_at()`**: a trigger function that sets `NEW.updated_at = now()`. Attached to five
  tables by the triggers in `0002_triggers_and_exclusions.sql`.
- **`forbid_update_delete()`**: a trigger function that raises an exception, unconditionally
  rejecting the operation. Attached to two append-only tables by the triggers in
  `0002_triggers_and_exclusions.sql`.

### `0002_triggers_and_exclusions.sql`

Runs after the table migration, since every statement here depends on tables (and `0000`'s
functions) already existing.

- **Five `trg_*_updated_at` triggers** (`users`, `caregivers`, `dependants`, `visit_schedules`, and
  `biometric_enrollments`, which `0017` removes along with its table): `BEFORE UPDATE ... EXECUTE FUNCTION
  set_updated_at()`. This is a real DB-level guarantee, not an application-level one - it fires
  for every writer (this backend, `psql`, a future second service), unlike Drizzle's
  `.$onUpdate()` column option, which only fires for writes that go through that specific Drizzle
  client. Don't add `.$onUpdate()` to these columns in `schema.ts`; it would be redundant at best
  and misleading at worst (implying the guarantee is application-level when it isn't).
- **Two `excl_visit_schedules_*_overlap` EXCLUDE constraints**: prevent the same caregiver, or the
  same dependant, from being booked into two overlapping `visit_schedules` time windows.
  `EXCLUDE USING gist (... WITH =, tstzrange(...) WITH &&)`, scoped to non-cancelled visits via a
  partial `WHERE (status <> 'cancelled')`. There is no `exclude()` export anywhere in
  `drizzle-orm/pg-core` (confirmed against the installed version) - this constraint type isn't
  representable in Drizzle's schema model at all, not just deferred by convention.
- **Two `trg_*_append_only` triggers** (`verification_attempts`, `audit_log`):
  `BEFORE UPDATE OR DELETE ... EXECUTE FUNCTION forbid_update_delete()`. Enforces at the database
  level that these two audit-trail tables can only ever be inserted into, never modified.
  `0012` adds the same trigger to `terms_acceptances`, and `0016` to `visit_resolutions`
  (compliance records: a later resolution supersedes an earlier one rather than rewriting it).

## Verifying these objects still work

There's no automated test for any of this yet (Linear HEZ-11, not done).
Until that lands, the way to check a change hasn't broken one of the objects above is to apply the
migrations to a real local Postgres database and exercise each one directly - this is what was
done manually when `0000`/`0002` were first written (see `docs/project-state.md`, "Custom Drizzle
migrations" section, for the exact checks and results):

```bash
npm run db:migrate
```

then, against that database:

- Update a row in any of the five triggered tables and confirm `updated_at` changed.
- Attempt an `UPDATE` or `DELETE` on `verification_attempts` or `audit_log` and confirm it's
  rejected.
- Attempt to insert two overlapping, non-cancelled `visit_schedules` rows for the same caregiver
  (or dependant) and confirm the second insert is rejected; confirm a `cancelled` row doesn't
  block an overlapping insert.

## Migration ordering

Numbered migrations run in order. As of this writing:

1. `0000_extensions_and_functions.sql` - hand-written, must stay first.
2. `0001_*.sql` - generated from `schema.ts`, the 12 tables.
3. `0002_triggers_and_exclusions.sql` - hand-written, must stay last.

A future `npm run db:generate` (from a `schema.ts` change) adds a new `0003_*.sql` after this one;
a future `npm run db:generate:custom` does the same. Neither command needs to know about this
ordering - it's only relevant if someone is manually restructuring the migration history (as
happened once already: see `docs/project-state.md` for why `0001`'s migration was renumbered from
its original `0000`).

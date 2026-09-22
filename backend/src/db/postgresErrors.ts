// Classifies a Postgres error wrapped by Drizzle's DrizzleQueryError, whose own top-level
// `.message` is a generic "Failed query: ..." string - the real Postgres error (`.code` included)
// is on `.cause` (established in enforcement.integration.test.ts, reused everywhere this project
// needs to branch on a specific Postgres error code, not just log-and-500 every DB error the same
// way).
// See https://www.postgresql.org/docs/current/errcodes-appendix.html

function getPostgresErrorField(err: unknown, field: 'code' | 'constraint'): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) {
    return undefined;
  }
  const value = (cause as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function getPostgresErrorCode(err: unknown): string | undefined {
  return getPostgresErrorField(err, 'code');
}

// The `constraint` field on a classified error's `.cause` (e.g. which EXCLUDE/CHECK/UNIQUE
// constraint fired) - only meaningful once a caller has already confirmed via one of the
// is-a-violation checks below which broad error class it's dealing with.
export function getPostgresConstraintName(err: unknown): string | undefined {
  return getPostgresErrorField(err, 'constraint');
}

// invalid_password, invalid_authorization_specification.
const POSTGRES_AUTH_ERROR_CODES = new Set(['28P01', '28000']);

export function isPostgresAuthError(err: unknown): boolean {
  const code = getPostgresErrorCode(err);
  return code !== undefined && POSTGRES_AUTH_ERROR_CODES.has(code);
}

export function isPostgresUniqueViolation(err: unknown): boolean {
  return getPostgresErrorCode(err) === '23505';
}

// exclusion_violation - the `excl_visit_schedules_caregiver_overlap`/
// `excl_visit_schedules_dependant_overlap` EXCLUDE USING gist constraints (HEZ-9), surfaced as a
// clean 409 by routes/visitSchedules.ts (HEZ-32) rather than a raw 500.
export function isPostgresExclusionViolation(err: unknown): boolean {
  return getPostgresErrorCode(err) === '23P01';
}

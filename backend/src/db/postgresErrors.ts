// Postgres error helpers. Drizzle wraps the driver error, so the real `.code` is on `.cause`.
// See https://www.postgresql.org/docs/current/errcodes-appendix.html

function getPostgresErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) {
    return undefined;
  }
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
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

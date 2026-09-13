import { describe, expect, it } from 'vitest';
import { isPostgresAuthError, isPostgresUniqueViolation } from './postgresErrors.js';

describe('isPostgresAuthError', () => {
  it('recognizes invalid_password (28P01)', () => {
    expect(isPostgresAuthError({ cause: { code: '28P01' } })).toBe(true);
  });

  it('recognizes invalid_authorization_specification (28000)', () => {
    expect(isPostgresAuthError({ cause: { code: '28000' } })).toBe(true);
  });

  it('returns false for an unrelated Postgres error code', () => {
    expect(isPostgresAuthError({ cause: { code: '23505' } })).toBe(false);
  });

  it('returns false when there is no cause', () => {
    expect(isPostgresAuthError(new Error('plain error'))).toBe(false);
  });

  it('returns false for non-object input', () => {
    expect(isPostgresAuthError('not an error')).toBe(false);
    expect(isPostgresAuthError(null)).toBe(false);
    expect(isPostgresAuthError(undefined)).toBe(false);
  });
});

describe('isPostgresUniqueViolation', () => {
  it('recognizes unique_violation (23505)', () => {
    expect(isPostgresUniqueViolation({ cause: { code: '23505' } })).toBe(true);
  });

  it('returns false for an unrelated Postgres error code', () => {
    expect(isPostgresUniqueViolation({ cause: { code: '28P01' } })).toBe(false);
  });

  it('returns false when there is no cause', () => {
    expect(isPostgresUniqueViolation(new Error('plain error'))).toBe(false);
  });
});

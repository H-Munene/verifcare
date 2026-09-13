import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from './client.js';
import { getLambdaDb, invalidateLambdaDb, isPostgresAuthError } from './lambdaDb.js';

const fakeDb = {} as Db;

describe('getLambdaDb caching', () => {
  beforeEach(() => {
    invalidateLambdaDb();
  });

  it('builds the db once and reuses the same cached promise on later calls', async () => {
    const builder = vi.fn().mockResolvedValue(fakeDb);

    const first = getLambdaDb(builder);
    const second = getLambdaDb(builder);

    expect(first).toBe(second);
    await expect(first).resolves.toBe(fakeDb);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it('clears the cache on rejection so the next call retries', async () => {
    const builder = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient Secrets Manager error'))
      .mockResolvedValueOnce(fakeDb);

    await expect(getLambdaDb(builder)).rejects.toThrow('transient Secrets Manager error');
    await expect(getLambdaDb(builder)).resolves.toBe(fakeDb);
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it('invalidateLambdaDb forces the next call to rebuild', async () => {
    const builder = vi.fn().mockResolvedValue(fakeDb);

    await getLambdaDb(builder);
    invalidateLambdaDb();
    await getLambdaDb(builder);

    expect(builder).toHaveBeenCalledTimes(2);
  });
});

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

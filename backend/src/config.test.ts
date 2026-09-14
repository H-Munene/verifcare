import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const requiredEnv = {
  USER_POOL_ID: 'eu-west-1_901G3wGkr',
  USER_POOL_CLIENT_ID: '62h8bi9cih94nhcd3hom9kheol',
};

describe('loadConfig', () => {
  it('accepts DATABASE_URL alone (local dev shape)', () => {
    const config = loadConfig({
      ...requiredEnv,
      DATABASE_URL: 'postgres://user:pass@localhost:5433/db',
    });

    expect(config).toEqual({
      port: 3000,
      databaseUrl: 'postgres://user:pass@localhost:5433/db',
      databaseSecretArn: undefined,
      userPoolId: requiredEnv.USER_POOL_ID,
      userPoolClientId: requiredEnv.USER_POOL_CLIENT_ID,
    });
  });

  it('accepts DATABASE_SECRET_ARN alone (Lambda shape)', () => {
    const config = loadConfig({
      ...requiredEnv,
      DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:eu-west-1:245361883778:secret:db-abc123',
    });

    expect(config.databaseUrl).toBeUndefined();
    expect(config.databaseSecretArn).toBe(
      'arn:aws:secretsmanager:eu-west-1:245361883778:secret:db-abc123',
    );
  });

  it('parses a custom PORT', () => {
    const config = loadConfig({
      ...requiredEnv,
      DATABASE_URL: 'postgres://localhost/db',
      PORT: '4000',
    });

    expect(config.port).toBe(4000);
  });

  it('defaults PORT to 3000 when unset', () => {
    const config = loadConfig({ ...requiredEnv, DATABASE_URL: 'postgres://localhost/db' });

    expect(config.port).toBe(3000);
  });

  it('throws when neither DATABASE_URL nor DATABASE_SECRET_ARN is set', () => {
    expect(() => loadConfig({ ...requiredEnv })).toThrow(
      /Either DATABASE_URL .* or DATABASE_SECRET_ARN/,
    );
  });

  it('throws a descriptive error for an invalid PORT', () => {
    expect(() =>
      loadConfig({ ...requiredEnv, DATABASE_URL: 'postgres://localhost/db', PORT: 'not-a-number' }),
    ).toThrow(/PORT/);
  });

  it('throws when USER_POOL_ID is missing', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://localhost/db', USER_POOL_CLIENT_ID: 'abc' }),
    ).toThrow(/USER_POOL_ID/);
  });

  it('throws when USER_POOL_CLIENT_ID is missing', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://localhost/db', USER_POOL_ID: 'abc' }),
    ).toThrow(/USER_POOL_CLIENT_ID/);
  });
});

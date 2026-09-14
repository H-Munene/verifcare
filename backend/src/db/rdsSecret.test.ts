import { describe, expect, it } from 'vitest';
import { parseRdsSecretJson, poolConfigFromRdsSecret } from './rdsSecret.js';

const validSecretJson = JSON.stringify({
  username: 'mzazi_care_admin',
  password: 'super-secret',
  engine: 'postgres',
  host: 'mzazi-care.abc123.eu-west-1.rds.amazonaws.com',
  port: 5432,
  dbname: 'mzazi_care',
  dbInstanceIdentifier: 'mzazi-care-database',
});

describe('parseRdsSecretJson', () => {
  it('parses a valid RDS-generated secret', () => {
    const secret = parseRdsSecretJson(validSecretJson);

    expect(secret).toEqual({
      username: 'mzazi_care_admin',
      password: 'super-secret',
      engine: 'postgres',
      host: 'mzazi-care.abc123.eu-west-1.rds.amazonaws.com',
      port: 5432,
      dbname: 'mzazi_care',
      dbInstanceIdentifier: 'mzazi-care-database',
    });
  });

  it('coerces a numeric-string port', () => {
    const raw = JSON.stringify({ ...JSON.parse(validSecretJson), port: '5432' });

    expect(parseRdsSecretJson(raw).port).toBe(5432);
  });

  it('throws on non-JSON input', () => {
    expect(() => parseRdsSecretJson('not json')).toThrow(/not valid JSON/);
  });

  it('throws on a JSON array instead of an object', () => {
    expect(() => parseRdsSecretJson('[]')).toThrow(/must be a JSON object/);
  });

  for (const field of [
    'username',
    'password',
    'engine',
    'host',
    'dbname',
    'dbInstanceIdentifier',
  ]) {
    it(`throws when "${field}" is missing`, () => {
      const parsed = JSON.parse(validSecretJson) as Record<string, unknown>;
      delete parsed[field];

      expect(() => parseRdsSecretJson(JSON.stringify(parsed))).toThrow(
        new RegExp(`required string field "${field}"`),
      );
    });
  }

  it('throws when port is missing or invalid', () => {
    const parsed = JSON.parse(validSecretJson) as Record<string, unknown>;
    delete parsed.port;

    expect(() => parseRdsSecretJson(JSON.stringify(parsed))).toThrow(/invalid "port" field/);
  });
});

describe('poolConfigFromRdsSecret', () => {
  it('maps secret fields to a PoolConfig with a bounded pool size and verified TLS', () => {
    const secret = parseRdsSecretJson(validSecretJson);
    const poolConfig = poolConfigFromRdsSecret(secret);

    expect(poolConfig).toMatchObject({
      host: 'mzazi-care.abc123.eu-west-1.rds.amazonaws.com',
      port: 5432,
      database: 'mzazi_care',
      user: 'mzazi_care_admin',
      password: 'super-secret',
      max: 2,
    });
    expect(poolConfig).not.toHaveProperty('engine');
    expect(poolConfig).not.toHaveProperty('dbInstanceIdentifier');

    const ssl = poolConfig.ssl;
    expect(typeof ssl).toBe('object');
    if (typeof ssl === 'object' && ssl !== null) {
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(typeof ssl.ca).toBe('string');
      expect(String(ssl.ca)).toContain('BEGIN CERTIFICATE');
    }
  });
});

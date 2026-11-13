import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const requiredEnv = {
  USER_POOL_ID: 'eu-west-1_901G3wGkr',
  USER_POOL_CLIENT_ID: '62h8bi9cih94nhcd3hom9kheol',
  CAREGIVER_USER_POOL_CLIENT_ID: '4th550b5rk8st5fmgfdio465tr',
  FAMILY_MEMBER_USER_POOL_CLIENT_ID: '7b63vkbmrooqvu4g5to6c1gtvk',
  VISIT_AUDIO_BUCKET_NAME: 'mzazicarestack-visitaudiobucket-abc123',
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
      userPoolClientIds: [
        requiredEnv.USER_POOL_CLIENT_ID,
        requiredEnv.CAREGIVER_USER_POOL_CLIENT_ID,
        requiredEnv.FAMILY_MEMBER_USER_POOL_CLIENT_ID,
      ],
      geofenceAccuracyThresholdMeters: 20,
      checkinSessionTokenTtlSeconds: 600,
      checkinQrTokenTtlSeconds: 60,
      visitAudioBucketName: requiredEnv.VISIT_AUDIO_BUCKET_NAME,
      voiceFunctionName: undefined,
    });
  });

  it('parses a custom CHECKIN_QR_TOKEN_TTL_SECONDS', () => {
    const config = loadConfig({
      ...requiredEnv,
      DATABASE_URL: 'postgres://localhost/db',
      CHECKIN_QR_TOKEN_TTL_SECONDS: '30',
    });

    expect(config.checkinQrTokenTtlSeconds).toBe(30);
  });

  it('throws when VISIT_AUDIO_BUCKET_NAME is missing', () => {
    expect(() =>
      loadConfig({
        ...withoutKey('VISIT_AUDIO_BUCKET_NAME'),
        DATABASE_URL: 'postgres://localhost/db',
      }),
    ).toThrow(/VISIT_AUDIO_BUCKET_NAME/);
  });

  it('defaults GEOFENCE_ACCURACY_THRESHOLD_METERS/CHECKIN_SESSION_TOKEN_TTL_SECONDS when unset', () => {
    const config = loadConfig({ ...requiredEnv, DATABASE_URL: 'postgres://localhost/db' });

    expect(config.geofenceAccuracyThresholdMeters).toBe(20);
    expect(config.checkinSessionTokenTtlSeconds).toBe(600);
  });

  it('parses custom GEOFENCE_ACCURACY_THRESHOLD_METERS/CHECKIN_SESSION_TOKEN_TTL_SECONDS', () => {
    const config = loadConfig({
      ...requiredEnv,
      DATABASE_URL: 'postgres://localhost/db',
      GEOFENCE_ACCURACY_THRESHOLD_METERS: '50',
      CHECKIN_SESSION_TOKEN_TTL_SECONDS: '300',
    });

    expect(config.geofenceAccuracyThresholdMeters).toBe(50);
    expect(config.checkinSessionTokenTtlSeconds).toBe(300);
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

  function withoutKey(key: keyof typeof requiredEnv): Record<string, string> {
    const copy: Record<string, string> = { ...requiredEnv };
    delete copy[key];
    return copy;
  }

  it('throws when USER_POOL_ID is missing', () => {
    expect(() =>
      loadConfig({ ...withoutKey('USER_POOL_ID'), DATABASE_URL: 'postgres://localhost/db' }),
    ).toThrow(/USER_POOL_ID/);
  });

  it('throws when USER_POOL_CLIENT_ID is missing', () => {
    expect(() =>
      loadConfig({
        ...withoutKey('USER_POOL_CLIENT_ID'),
        DATABASE_URL: 'postgres://localhost/db',
      }),
    ).toThrow(/USER_POOL_CLIENT_ID/);
  });

  it('throws when CAREGIVER_USER_POOL_CLIENT_ID is missing', () => {
    expect(() =>
      loadConfig({
        ...withoutKey('CAREGIVER_USER_POOL_CLIENT_ID'),
        DATABASE_URL: 'postgres://localhost/db',
      }),
    ).toThrow(/CAREGIVER_USER_POOL_CLIENT_ID/);
  });

  it('throws when FAMILY_MEMBER_USER_POOL_CLIENT_ID is missing', () => {
    expect(() =>
      loadConfig({
        ...withoutKey('FAMILY_MEMBER_USER_POOL_CLIENT_ID'),
        DATABASE_URL: 'postgres://localhost/db',
      }),
    ).toThrow(/FAMILY_MEMBER_USER_POOL_CLIENT_ID/);
  });
});

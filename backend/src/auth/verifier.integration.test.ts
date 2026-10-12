// Runs real RS256 verification through CognitoJwtVerifier with a locally generated key, preloaded
// via cacheJwks() so there's no network call. Catches tokenUse/audience/issuer mistakes that the
// mocked tests in middleware.test.ts can't.

import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { describe, expect, it } from 'vitest';

const USER_POOL_ID = 'eu-west-1_TESTPOOL01';
const CLIENT_ID = 'test-client-id';
const ISSUER = `https://cognito-idp.eu-west-1.amazonaws.com/${USER_POOL_ID}`;
const KEY_ID = 'test-key-1';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signTestIdToken(privateKey: KeyObject, claims: Record<string, unknown>): string {
  const header = { alg: 'RS256', kid: KEY_ID, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    token_use: 'id',
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: now,
    exp: now + 3600,
    ...claims,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

describe('CognitoJwtVerifier with tokenUse: id (real RS256 verification)', () => {
  it('accepts a validly-signed ID token containing custom:role', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };

    const verifier = CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      tokenUse: 'id',
      clientId: CLIENT_ID,
    });
    verifier.cacheJwks({
      keys: [{ ...jwk, kid: KEY_ID, alg: 'RS256', use: 'sig' }],
    });

    const token = signTestIdToken(privateKey, {
      sub: 'a1b2c3d4-0000-0000-0000-000000000000',
      'custom:role': 'caregiver',
      email: 'caregiver@example.com',
    });

    const payload = await verifier.verify(token);

    expect(payload.sub).toBe('a1b2c3d4-0000-0000-0000-000000000000');
    expect(payload['custom:role']).toBe('caregiver');
  });

  it('rejects a token signed with a different (unregistered) key', async () => {
    const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };

    const verifier = CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      tokenUse: 'id',
      clientId: CLIENT_ID,
    });
    // Cache the legitimate key, but sign the token with a different, unregistered private key -
    // simulates a forged token.
    verifier.cacheJwks({ keys: [{ ...jwk, kid: KEY_ID, alg: 'RS256', use: 'sig' }] });

    const forgedToken = signTestIdToken(attacker.privateKey, {
      sub: 'attacker',
      'custom:role': 'supervisor',
    });

    await expect(verifier.verify(forgedToken)).rejects.toThrow();
  });

  it('accepts a token whose audience matches one of several configured client ids', async () => {
    // Tokens from any configured app client must verify, not just the web client's.
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
    const otherClientId = 'other-app-client-id';

    const verifier = CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      tokenUse: 'id',
      clientId: [CLIENT_ID, otherClientId],
    });
    verifier.cacheJwks({ keys: [{ ...jwk, kid: KEY_ID, alg: 'RS256', use: 'sig' }] });

    // Signed for the second client id.
    const header = { alg: 'RS256', kid: KEY_ID, typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      token_use: 'id',
      iss: ISSUER,
      aud: otherClientId,
      iat: now,
      exp: now + 3600,
      sub: 'abc',
      'custom:role': 'family_member',
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
    const token = `${signingInput}.${base64url(signature)}`;

    const verifiedPayload = await verifier.verify(token);
    expect(verifiedPayload.sub).toBe('abc');
  });

  it('rejects a token with a mismatched audience (clientId)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };

    const verifier = CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      tokenUse: 'id',
      clientId: CLIENT_ID,
    });
    verifier.cacheJwks({ keys: [{ ...jwk, kid: KEY_ID, alg: 'RS256', use: 'sig' }] });

    const header = { alg: 'RS256', kid: KEY_ID, typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      token_use: 'id',
      iss: ISSUER,
      aud: 'some-other-client-id',
      iat: now,
      exp: now + 3600,
      sub: 'abc',
      'custom:role': 'caregiver',
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
    const token = `${signingInput}.${base64url(signature)}`;

    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };

    const verifier = CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      tokenUse: 'id',
      clientId: CLIENT_ID,
    });
    verifier.cacheJwks({ keys: [{ ...jwk, kid: KEY_ID, alg: 'RS256', use: 'sig' }] });

    const header = { alg: 'RS256', kid: KEY_ID, typ: 'JWT' };
    const past = Math.floor(Date.now() / 1000) - 7200;
    const payload = {
      token_use: 'id',
      iss: ISSUER,
      aud: CLIENT_ID,
      iat: past,
      exp: past + 3600,
      sub: 'abc',
      'custom:role': 'caregiver',
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
    const token = `${signingInput}.${base64url(signature)}`;

    await expect(verifier.verify(token)).rejects.toThrow();
  });
});

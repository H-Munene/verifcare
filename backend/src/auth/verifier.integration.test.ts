// Exercises real RS256 signature verification through aws-jwt-verify's CognitoJwtVerifier - the
// same construction verifier.ts's createIdTokenVerifier() uses (userPoolId, tokenUse: 'id',
// clientId) - rather than only testing against a fully-mocked verifier (middleware.test.ts covers
// that). A real RSA keypair signs a test JWT locally; CognitoJwtVerifier.cacheJwks() preloads the
// matching public key so no network call to a real Cognito JWKS endpoint is needed. This exists to
// catch a real, easy-to-get-wrong class of mistake (wrong tokenUse, wrong clientId/audience
// matching, wrong issuer format) that a fully-mocked verifier test cannot catch, since it never
// exercises the real verification logic at all.

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

// generateKeyPairSync('rsa', { modulusLength: 2048 }) (no encoding options) returns KeyObject, not
// a PEM string - node:crypto's sign() accepts either, so this worked at runtime all along, but the
// parameter's declared type here was wrong (a pre-existing type error, not caught by npm run build
// since tsconfig.build.json excludes test files, nor by `npm test` since Vitest's esbuild
// transform doesn't type-check - only found by running tsc -p tsconfig.json directly).
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

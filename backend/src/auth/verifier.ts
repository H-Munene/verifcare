// Cognito ID token verification. ID token rather than access token, because access tokens don't
// carry custom attributes like custom:role without a Pre Token Generation trigger.

import { CognitoJwtVerifier } from 'aws-jwt-verify';

// Matches the users.role enum.
export type UserRole = 'supervisor' | 'caregiver' | 'family_member';
const USER_ROLES: readonly UserRole[] = ['supervisor', 'caregiver', 'family_member'];

// A verified identity that may not have a role yet (a new signup before POST /users).
export interface VerifiedIdentity {
  sub: string;
  role: UserRole | undefined;
  email: string | undefined;
}

export interface AuthenticatedUser {
  sub: string;
  role: UserRole;
  email: string | undefined;
}

// Loosely typed so tests can pass a fake instead of hitting Cognito's JWKS endpoint.
export interface IdTokenVerifier {
  // Property syntax, not a method, to keep eslint's unbound-method rule quiet.
  verify: (jwt: string) => Promise<Record<string, unknown>>;
}

// Takes every app client id (web and both mobile apps); tokens from any of them are valid.
export function createIdTokenVerifier(userPoolId: string, clientIds: string[]): IdTokenVerifier {
  const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId: clientIds });
  return {
    verify: (jwt: string) => verifier.verify(jwt),
  };
}

// Throws on a missing sub or an unknown custom:role, so callers treat it as a 401. A missing
// custom:role is fine: new signups don't have one yet.
export function extractIdentity(payload: Record<string, unknown>): VerifiedIdentity {
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub === '') {
    throw new Error('ID token payload is missing a sub claim.');
  }

  const rawRole = payload['custom:role'];
  let role: UserRole | undefined;
  if (rawRole !== undefined && rawRole !== null) {
    if (typeof rawRole !== 'string' || !USER_ROLES.includes(rawRole as UserRole)) {
      throw new Error(
        `ID token payload has an invalid custom:role claim: ${JSON.stringify(rawRole)}.`,
      );
    }
    role = rawRole as UserRole;
  }

  const email = payload.email;
  return { sub, role, email: typeof email === 'string' ? email : undefined };
}

// Like extractIdentity, but requires a role.
export function extractUser(payload: Record<string, unknown>): AuthenticatedUser {
  const identity = extractIdentity(payload);
  if (!identity.role) {
    throw new Error(
      'ID token payload has no custom:role claim - this identity has not been assigned a role yet.',
    );
  }
  return { sub: identity.sub, role: identity.role, email: identity.email };
}

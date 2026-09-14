// Cognito ID token verification. Uses the ID token specifically, not the access token - verified
// against AWS's current Cognito documentation before implementing: a Cognito access token's
// default payload does NOT include custom attributes (only sub, cognito:groups, scope, client_id,
// etc.) unless a Pre Token Generation Lambda trigger is configured, which this project has none
// of. custom:role, a custom attribute (architecture.md's deliberate choice over Cognito Groups,
// since a user has exactly one role), therefore only ever appears in the ID token. openapi.yaml's
// bearerAuth scheme is updated to state this as settled, not left open.

import { CognitoJwtVerifier } from 'aws-jwt-verify';

// Matches schema.sql's users.role enum and architecture.md's role model exactly.
export type UserRole = 'supervisor' | 'caregiver' | 'family_member';
const USER_ROLES: readonly UserRole[] = ['supervisor', 'caregiver', 'family_member'];

// A verified identity that may not have a role yet - the case for a genuinely new Cognito
// self-signup, before POST /users has assigned one (see routes/users.ts and infra/lib/auth.ts's
// custom:role write-access fix). Every AuthenticatedUser is also a VerifiedIdentity; the reverse
// is not true.
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

// Deliberately loose (not aws-jwt-verify's own precise generic return type) so this interface can
// also be satisfied by a fake in tests, without needing a real signed JWT and network access to
// Cognito's JWKS endpoint for every test. verifyIdToken() below adapts the real verifier to this
// shape at the one integration point.
export interface IdTokenVerifier {
  // Property-typed (not method shorthand) so this interface stays assignable from both a plain
  // object literal (tests) and a wrapped arrow function, without eslint's unbound-method check
  // treating it as a class-style method that could lose its `this` binding.
  verify: (jwt: string) => Promise<Record<string, unknown>>;
}

// clientId accepts an array (aws-jwt-verify's own support for multiple accepted audiences) -
// required since this project has three separate app clients under one user pool (web, caregiver
// mobile, family-member mobile - see infra/lib/auth.ts), and a real ID token's aud/client_id
// claim is always exactly one of them, never the others. Passing only one client id here would
// reject every token issued by the other two clients as unverifiable, indistinguishable from a
// genuinely invalid token (a real bug found 2026-09-14: this function originally took a single
// clientId, so every mobile app sign-in failed backend calls with a generic 401).
export function createIdTokenVerifier(userPoolId: string, clientIds: string[]): IdTokenVerifier {
  const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId: clientIds });
  return {
    verify: (jwt: string) => verifier.verify(jwt),
  };
}

// Throws (does not return undefined) only on a missing sub claim, or a custom:role claim that is
// present but not one of the three known roles (a tampered or otherwise malformed token) - both
// callers (extractUser and requireVerifiedIdentity) need "verified signature but unusable
// payload" to be indistinguishable from "verification failed", i.e. a 401, not a crash deeper in
// route code. A genuinely ABSENT custom:role claim is not an error here - that is the expected
// shape for a brand-new Cognito self-signup that has not been assigned a role yet.
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

// Same as extractIdentity, but additionally requires a role to be present - what every route
// except POST /users' self-signup path needs.
export function extractUser(payload: Record<string, unknown>): AuthenticatedUser {
  const identity = extractIdentity(payload);
  if (!identity.role) {
    throw new Error(
      'ID token payload has no custom:role claim - this identity has not been assigned a role yet.',
    );
  }
  return { sub: identity.sub, role: identity.role, email: identity.email };
}

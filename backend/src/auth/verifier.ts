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

export function createIdTokenVerifier(userPoolId: string, clientId: string): IdTokenVerifier {
  const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId });
  return {
    verify: (jwt: string) => verifier.verify(jwt),
  };
}

// Throws (does not return undefined/null) on a missing or malformed sub/custom:role claim, so
// callers can treat "verified signature but unusable payload" the same way as "verification
// failed" - both are a 401, not a crash deeper in route code.
export function extractUser(payload: Record<string, unknown>): AuthenticatedUser {
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub === '') {
    throw new Error('ID token payload is missing a sub claim.');
  }

  const role = payload['custom:role'];
  if (typeof role !== 'string' || !USER_ROLES.includes(role as UserRole)) {
    throw new Error(
      `ID token payload has a missing or invalid custom:role claim: ${JSON.stringify(role)}.`,
    );
  }

  const email = payload.email;
  return { sub, role: role as UserRole, email: typeof email === 'string' ? email : undefined };
}

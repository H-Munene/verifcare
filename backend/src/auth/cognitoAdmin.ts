// Server-side role assignment for a genuinely new Cognito self-signup (HEZ-29). The only way
// custom:role can be set at all now, since infra/lib/auth.ts removed the app client's own write
// access to it - a self-signing-up user's own session can never set this directly, closing the
// privilege-escalation gap that write access left open (a self-signup could otherwise set
// custom:role to "supervisor" with zero backend involvement).

import {
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { UserRole } from './verifier.js';

export interface CognitoAdmin {
  // Property-typed (not method shorthand) so this interface stays assignable from a plain object
  // literal in tests without eslint's unbound-method check treating it as a class-style method -
  // same reasoning as auth/verifier.ts's IdTokenVerifier.
  assignRole: (sub: string, role: UserRole) => Promise<void>;
}

// Classifies an AdminUpdateUserAttributes rejection caused by a cognitoSub that doesn't
// correspond to any real Cognito user - lets a route turn this into a clean 400 instead of
// letting the raw AWS SDK error surface as a 500 (HEZ-30, when a submitted cognitoSub is invalid
// rather than merely unassigned a role yet). Checked against the AWS SDK v3 error-handling
// convention (both e.name and instanceof are safe, since the SDK overrides Symbol.hasInstance for
// modeled exceptions) - e.name is used here since importing the exception class just to compare
// identity would be no more precise for this single check.
export function isCognitoUserNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'UserNotFoundException'
  );
}

export function createCognitoAdmin(userPoolId: string): CognitoAdmin {
  const client = new CognitoIdentityProviderClient({});
  return {
    assignRole: async (sub: string, role: UserRole): Promise<void> => {
      await client.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          // Verified against AWS's AdminUpdateUserAttributes documentation, not assumed: "If
          // username isn't an alias attribute in your user pool, this value must be the sub of a
          // local user." This pool's sign-in aliases are email/phone only (infra/lib/auth.ts),
          // not username - so sub is not just "also accepted" here, it is the required value.
          Username: sub,
          UserAttributes: [{ Name: 'custom:role', Value: role }],
        }),
      );
    },
  };
}

// Server-side role assignment for a genuinely new Cognito self-signup (HEZ-29), and server-side
// creation of a brand-new Cognito identity for a dependant's family contact who has never touched
// Cognito at all (2026-09-14, extending HEZ-30/HEZ-56). The only way custom:role can be set at
// all now, since infra/lib/auth.ts removed the app client's own write access to it - a
// self-signing-up user's own session can never set this directly, closing the privilege-
// escalation gap that write access left open (a self-signup could otherwise set custom:role to
// "supervisor" with zero backend involvement).

import {
  AdminCreateUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { UserRole } from './verifier.js';

export interface CognitoIdentityLookup {
  cognitoSub: string;
  email: string;
  phoneNumber: string | null;
  fullName: string | null;
}

export interface CognitoAdmin {
  // Property-typed (not method shorthand) so this interface stays assignable from a plain object
  // literal in tests without eslint's unbound-method check treating it as a class-style method -
  // same reasoning as auth/verifier.ts's IdTokenVerifier.
  assignRole: (sub: string, role: UserRole) => Promise<void>;
  // Creates a brand-new Cognito identity (for someone who has never signed up or been created
  // before) and returns its Cognito-generated sub. Sends a real invitation email with a Cognito-
  // generated temporary password - the new person completes sign-in via the NEW_PASSWORD_REQUIRED
  // flow the login page already handles (see auth/cognito.ts).
  createUser: (params: {
    email: string;
    phoneNumber: string;
    fullName: string;
    role: UserRole;
  }) => Promise<string>;
  // Resolves an email to a Cognito identity that may have no `users` row here yet (HEZ-54) - a
  // caregiver's Cognito account is always created outside this app (there's no caregiver
  // self-signup flow, HEZ-63/64 still Backlog), so POST /caregivers's required cognitoSub has to
  // come from somewhere; this is that somewhere. Returns null if no Cognito user has that email -
  // never throws for "not found", since that's an expected, common outcome here, not an error.
  lookupUserByEmail: (email: string) => Promise<CognitoIdentityLookup | null>;
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

// Classifies an AdminCreateUser rejection caused by the email already being registered in
// Cognito - either as the Username itself (UsernameExistsException, since createUser below uses
// the email as Username) or as an alias on a different user (AliasExistsException, possible if
// that email was registered with a different Username at some point). Both mean the same thing to
// a caller: this person already has a Cognito identity, use the search/link flow instead of create.
export function isCognitoUserAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const name = (err as { name?: unknown }).name;
  return name === 'UsernameExistsException' || name === 'AliasExistsException';
}

// Classifies an AdminCreateUser rejection caused by one of the submitted attributes failing
// Cognito's own validation (most commonly phone_number not being E.164 - found via a real
// "Internal Server Error" report where a locally-formatted phone number reached AdminCreateUser
// unvalidated, since routes/dependants.ts's own zod schema didn't check the format at the time).
// zod-level validation now catches the common phone-format case before Cognito is ever called;
// this stays as a fallback for whatever that regex doesn't anticipate, so a rejection here still
// becomes a clean 400 instead of an unhandled 500. Cognito's own message (e.g. "Invalid phone
// number format.") is not sensitive - it's Cognito describing its own validation rule, not
// leaking anything about this account or user pool - so it's safe to relay directly to the caller.
export function isCognitoInvalidParameterError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'InvalidParameterException'
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
    createUser: async ({ email, phoneNumber, fullName, role }): Promise<string> => {
      // Username: required by the API even though this pool has no real username sign-in
      // attribute (email/phone are aliases, not UsernameAttributes) - verified against AWS's
      // AdminCreateUser documentation: "You can only provide a value if usernames are a valid
      // sign-in attribute for your user pool" - Cognito accepts an opaque value here regardless,
      // so the email is used for readability in the Cognito console's user list. The real,
      // permanent identifier is the Cognito-generated `sub` this function returns, never
      // `Username` - everything else in this app already keys off sub, not Username.
      const response = await client.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: email,
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'phone_number', Value: phoneNumber },
            { Name: 'name', Value: fullName },
            { Name: 'custom:role', Value: role },
          ],
          // Explicit, not left to AWS's default: AdminCreateUser defaults DesiredDeliveryMediums
          // to SMS when unspecified (confirmed against AWS's own docs), which would silently
          // trigger the still-unresolved SNS/SMS-pricing-to-Kenya cost question flagged since
          // HEZ-17. Email sidesteps that entirely. TemporaryPassword is deliberately omitted -
          // Cognito generates one and delivers it in the invitation email.
          DesiredDeliveryMediums: ['EMAIL'],
        }),
      );
      const sub = response.User?.Attributes?.find((attr) => attr.Name === 'sub')?.Value;
      if (!sub) {
        throw new Error('AdminCreateUser response did not include a sub attribute.');
      }
      return sub;
    },
    lookupUserByEmail: async (email: string): Promise<CognitoIdentityLookup | null> => {
      // Filter syntax confirmed against AWS's ListUsers documentation: `"AttributeName = \"value\""`,
      // exact match only (no wildcard needed or wanted here). Safe to interpolate email directly -
      // the caller already validated it as a well-formed email address (no quote characters
      // possible) before this ever runs.
      const response = await client.send(
        new ListUsersCommand({
          UserPoolId: userPoolId,
          Filter: `email = "${email}"`,
          Limit: 1,
        }),
      );
      const user = response.Users?.[0];
      if (!user) {
        return null;
      }
      const attribute = (name: string): string | null =>
        user.Attributes?.find((attr) => attr.Name === name)?.Value ?? null;
      const sub = attribute('sub');
      if (!sub) {
        throw new Error('ListUsers response did not include a sub attribute.');
      }
      return {
        cognitoSub: sub,
        email: attribute('email') ?? email,
        phoneNumber: attribute('phone_number'),
        fullName: attribute('name'),
      };
    },
  };
}

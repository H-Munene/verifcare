// Server-side Cognito admin calls: assigning custom:role, and creating identities for family
// contacts. The app client can't write custom:role, so a self-signup can't make itself supervisor.

import {
  AdminCreateUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type { UserRole } from './verifier.js';

export interface CognitoAdmin {
  // Property syntax, not methods, to keep eslint's unbound-method rule quiet in tests.
  assignRole: (sub: string, role: UserRole) => Promise<void>;
  // Creates a new Cognito user and returns its sub. Cognito emails a temporary password.
  createUser: (params: {
    email: string;
    phoneNumber: string;
    fullName: string;
    role: UserRole;
  }) => Promise<string>;
}

// True when the cognitoSub doesn't exist in Cognito, so routes can return 400 instead of 500.
export function isCognitoUserNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'UserNotFoundException'
  );
}

// True when the email is already taken, as a username or an alias on another user.
export function isCognitoUserAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const name = (err as { name?: unknown }).name;
  return name === 'UsernameExistsException' || name === 'AliasExistsException';
}

export function createCognitoAdmin(userPoolId: string): CognitoAdmin {
  const client = new CognitoIdentityProviderClient({});
  return {
    assignRole: async (sub: string, role: UserRole): Promise<void> => {
      await client.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          // The pool has no username alias, so Cognito requires the sub here.
          Username: sub,
          UserAttributes: [{ Name: 'custom:role', Value: role }],
        }),
      );
    },
    createUser: async ({ email, phoneNumber, fullName, role }): Promise<string> => {
      // Username is required but unused for sign-in; email just makes the console readable.
      // The app keys everything off sub.
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
          // Defaults to SMS otherwise, and SMS pricing to Kenya is still unresolved.
          DesiredDeliveryMediums: ['EMAIL'],
        }),
      );
      const sub = response.User?.Attributes?.find((attr) => attr.Name === 'sub')?.Value;
      if (!sub) {
        throw new Error('AdminCreateUser response did not include a sub attribute.');
      }
      return sub;
    },
  };
}

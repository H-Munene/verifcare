// Thin wrapper around amazon-cognito-identity-js: SRP sign-in and session refresh, no Hosted UI.

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';

const userPool = new CognitoUserPool({
  UserPoolId: import.meta.env.VITE_USER_POOL_ID,
  ClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
});

export interface IdentityClaims {
  sub: string;
  email: string | undefined;
  role: 'supervisor' | 'caregiver' | 'family_member' | undefined;
}

// Display only; the backend verifies the token on every request.
export function decodeIdentity(idToken: string): IdentityClaims {
  const payloadSegment = idToken.split('.')[1];
  if (!payloadSegment) {
    throw new Error('Malformed ID token.');
  }
  const payload = JSON.parse(atob(payloadSegment.replace(/-/g, '+').replace(/_/g, '/'))) as Record<
    string,
    unknown
  >;
  const sub = payload.sub;
  if (typeof sub !== 'string') {
    throw new Error('ID token payload is missing a sub claim.');
  }
  const email = payload.email;
  const role = payload['custom:role'];
  return {
    sub,
    email: typeof email === 'string' ? email : undefined,
    role:
      role === 'supervisor' || role === 'caregiver' || role === 'family_member' ? role : undefined,
  };
}

// Returned when signing in with a temporary password (any admin-created account). Only pass
// required attributes that don't have a value yet to completeNewPassword.
export interface NewPasswordRequiredResult {
  type: 'newPasswordRequired';
  requiredAttributes: string[];
  completeNewPassword: (
    newPassword: string,
    requiredAttributeValues?: Record<string, string>,
  ) => Promise<CognitoUserSession>;
}
export interface SignInSuccessResult {
  type: 'success';
  session: CognitoUserSession;
}
export type SignInResult = SignInSuccessResult | NewPasswordRequiredResult;

export function signIn(email: string, password: string): Promise<SignInResult> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email, Pool: userPool });
    const authDetails = new AuthenticationDetails({ Username: email, Password: password });
    user.authenticateUser(authDetails, {
      onSuccess: (session) => resolve({ type: 'success', session }),
      onFailure: (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
      newPasswordRequired: (_userAttributes: unknown, requiredAttributes: unknown) => {
        resolve({
          type: 'newPasswordRequired',
          requiredAttributes: Array.isArray(requiredAttributes)
            ? requiredAttributes.filter((attr): attr is string => typeof attr === 'string')
            : [],
          completeNewPassword: (newPassword, requiredAttributeValues = {}) =>
            new Promise((res, rej) => {
              user.completeNewPasswordChallenge(newPassword, requiredAttributeValues, {
                onSuccess: (completedSession) => res(completedSession),
                onFailure: (completeErr: unknown) =>
                  rej(completeErr instanceof Error ? completeErr : new Error(String(completeErr))),
              });
            }),
        });
      },
    });
  });
}

// Returns the ID token, refreshing it if needed, or null if there's no usable session.
export function getCurrentIdToken(): Promise<string | null> {
  const user = userPool.getCurrentUser();
  if (!user) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session?.isValid()) {
        resolve(null);
        return;
      }
      resolve(session.getIdToken().getJwtToken());
    });
  });
}

export function signOut(): void {
  userPool.getCurrentUser()?.signOut();
}

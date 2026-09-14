// Thin wrapper around amazon-cognito-identity-js for exactly the flow this app's Cognito app
// client supports: SRP username/password sign-in (ALLOW_USER_SRP_AUTH), no OAuth Hosted UI.
// amazon-cognito-identity-js was chosen over full AWS Amplify specifically because this app needs
// nothing beyond SRP sign-in and session/token refresh - Amplify's Auth/API/Storage/DataStore
// surface would be unused weight, matching this project's existing preference for lean, purpose-
// fit dependencies (e.g. aws-jwt-verify on the backend).

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

// Client-side decode only, for display purposes (the current user's email/role in the app shell) -
// never trusted as an authorization decision. The backend independently re-verifies every token's
// signature on every request (see backend/src/auth/verifier.ts) regardless of what this app does
// with the decoded claims.
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

// A console- or AdminCreateUser-created account always starts with a temporary password (the
// Cognito console has no "set a permanent password" action - confirmed against AWS's own
// AdminSetUserPassword docs, that's API/CLI-only). Signing in with one returns this challenge
// instead of a session; the app must prompt for a new password before the account is usable. Only
// truly required attributes belong in `completeNewPassword`'s second argument - per AWS's own
// RespondToAuthChallenge docs: "you can't modify a required attribute that already has a value."
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

// Resolves the current session's ID token, transparently refreshing it via the library's own
// getSession() if the cached access token has expired but the refresh token is still valid.
// Resolves to null if there is no signed-in user or the session can't be refreshed (expired
// refresh token) - callers treat that as "not authenticated", not an error.
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

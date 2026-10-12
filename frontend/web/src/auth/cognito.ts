// Thin wrapper around amazon-cognito-identity-js for exactly the flow this app's Cognito app
// client supports: SRP username/password sign-in (ALLOW_USER_SRP_AUTH), no OAuth Hosted UI, plus
// self-service password reset (ForgotPassword / ConfirmForgotPassword - public Cognito calls made
// with the client id, so the Mzazi Care API isn't involved).
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
import { getConfig } from '../config';

// Built on first use, not at import, because the IDs come from the runtime config (../config.ts).
let pool: CognitoUserPool | undefined;
function userPool(): CognitoUserPool {
  pool ??= new CognitoUserPool({
    UserPoolId: getConfig().userPoolId,
    ClientId: getConfig().userPoolClientId,
  });
  return pool;
}

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
// An administrator reset this account's password (AdminResetUserPassword, e.g. from the Cognito
// console): Cognito refuses the old password and has already emailed a reset code, so sign-in
// continues in the reset form's code step rather than failing.
export interface PasswordResetRequiredResult {
  type: 'passwordResetRequired';
}
export type SignInResult =
  SignInSuccessResult | NewPasswordRequiredResult | PasswordResetRequiredResult;

// amazon-cognito-identity-js rejects with the service's error, whose `code` is the Cognito
// exception name (e.g. "CodeMismatchException").
export function cognitoErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function signIn(email: string, password: string): Promise<SignInResult> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email, Pool: userPool() });
    const authDetails = new AuthenticationDetails({ Username: email, Password: password });
    user.authenticateUser(authDetails, {
      onSuccess: (session) => resolve({ type: 'success', session }),
      onFailure: (err: unknown) => {
        if (cognitoErrorCode(err) === 'PasswordResetRequiredException') {
          resolve({ type: 'passwordResetRequired' });
          return;
        }
        reject(asError(err));
      },
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

// Asks Cognito to email a reset code to the account's verified email (the pool's account recovery
// is email only - see infra/lib/auth.ts). The app clients prevent user-existence errors, so an
// unknown email also resolves without anything being sent; UserNotFoundException is treated the
// same way in case a client ever answers the legacy way, so the form never reveals whether an
// email is registered.
export function requestPasswordReset(email: string): Promise<void> {
  return new Promise((resolve, reject) => {
    new CognitoUser({ Username: email, Pool: userPool() }).forgotPassword({
      onSuccess: () => resolve(),
      // Fired instead of onSuccess once the code is on its way, when this callback is supplied.
      inputVerificationCode: () => resolve(),
      onFailure: (err: unknown) =>
        cognitoErrorCode(err) === 'UserNotFoundException' ? resolve() : reject(asError(err)),
    });
  });
}

// Sets the new password with the emailed code. Returns no session - the user signs in afterwards.
export function confirmPasswordReset(
  email: string,
  code: string,
  newPassword: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    new CognitoUser({ Username: email, Pool: userPool() }).confirmPassword(code, newPassword, {
      onSuccess: () => resolve(),
      onFailure: (err: unknown) => reject(asError(err)),
    });
  });
}

// Resolves the current session's ID token, transparently refreshing it via the library's own
// getSession() if the cached access token has expired but the refresh token is still valid.
// Resolves to null if there is no signed-in user or the session can't be refreshed (expired
// refresh token) - callers treat that as "not authenticated", not an error.
export function getCurrentIdToken(): Promise<string | null> {
  const user = userPool().getCurrentUser();
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
  userPool().getCurrentUser()?.signOut();
}

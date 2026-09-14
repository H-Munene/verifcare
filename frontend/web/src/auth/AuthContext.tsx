import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import * as cognito from './cognito';
import type { IdentityClaims, NewPasswordRequiredResult, SignInResult } from './cognito';

interface AuthContextValue {
  identity: IdentityClaims | null;
  loading: boolean;
  // Resolves to a NewPasswordRequiredResult when the account has a temporary password (always the
  // case for a console- or AdminCreateUser-created account) - the caller (LoginPage) is
  // responsible for branching on `result.type` and, for the temporary-password case, collecting a
  // new password and calling completeNewPassword below.
  signIn: (email: string, password: string) => Promise<SignInResult>;
  completeNewPassword: (
    result: NewPasswordRequiredResult,
    newPassword: string,
    requiredAttributeValues?: Record<string, string>,
  ) => Promise<void>;
  signOut: () => void;
  // Used by api/client.ts to attach a fresh bearer token to every request - not read from
  // `identity` directly, since a cached identity can outlive its underlying token.
  getIdToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<IdentityClaims | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await cognito.getCurrentIdToken();
        if (cancelled) {
          return;
        }
        setIdentity(token ? cognito.decodeIdentity(token) : null);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await cognito.signIn(email, password);
    if (result.type === 'success') {
      setIdentity(cognito.decodeIdentity(result.session.getIdToken().getJwtToken()));
    }
    return result;
  }, []);

  const completeNewPassword = useCallback(
    async (
      result: NewPasswordRequiredResult,
      newPassword: string,
      requiredAttributeValues?: Record<string, string>,
    ) => {
      const session = await result.completeNewPassword(newPassword, requiredAttributeValues);
      setIdentity(cognito.decodeIdentity(session.getIdToken().getJwtToken()));
    },
    [],
  );

  const signOut = useCallback(() => {
    cognito.signOut();
    setIdentity(null);
  }, []);

  const getIdToken = useCallback(() => cognito.getCurrentIdToken(), []);

  return (
    <AuthContext.Provider
      value={{ identity, loading, signIn, completeNewPassword, signOut, getIdToken }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// Context + hook are deliberately co-located (the standard React pattern) rather than split
// across files just to satisfy react-refresh's single-component-export preference - that rule
// only affects Fast Refresh's dev-mode granularity, not production behavior.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth() must be used within an AuthProvider.');
  }
  return ctx;
}

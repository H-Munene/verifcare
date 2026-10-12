import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import * as cognito from './cognito';
import type { IdentityClaims, NewPasswordRequiredResult, SignInResult } from './cognito';

interface AuthContextValue {
  identity: IdentityClaims | null;
  loading: boolean;
  // Returns a NewPasswordRequiredResult for temporary passwords; call completeNewPassword next.
  signIn: (email: string, password: string) => Promise<SignInResult>;
  completeNewPassword: (
    result: NewPasswordRequiredResult,
    newPassword: string,
    requiredAttributeValues?: Record<string, string>,
  ) => Promise<void>;
  signOut: () => void;
  // Always fetches a fresh token; `identity` can outlive it.
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

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth() must be used within an AuthProvider.');
  }
  return ctx;
}

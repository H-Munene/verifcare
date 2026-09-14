import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, type Location } from 'react-router-dom';
import type { NewPasswordRequiredResult } from '../auth/cognito';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../design-system/Button';
import { Input } from '../design-system/Input';
import './LoginPage.css';

export function LoginPage() {
  const { identity } = useAuth();
  const location = useLocation();
  const [challenge, setChallenge] = useState<NewPasswordRequiredResult | null>(null);

  if (identity) {
    const from = (location.state as { from?: Location } | null)?.from;
    return <Navigate to={from?.pathname ?? '/dependants'} replace />;
  }

  return (
    <div className="login-page">
      <div className="login-page__card">
        <div className="login-page__title">Mzazi Care</div>
        <div className="login-page__subtitle">Supervisor sign in</div>
        {challenge ? (
          <NewPasswordForm challenge={challenge} />
        ) : (
          <SignInForm onNewPasswordRequired={setChallenge} />
        )}
      </div>
    </div>
  );
}

function SignInForm({
  onNewPasswordRequired,
}: {
  onNewPasswordRequired: (challenge: NewPasswordRequiredResult) => void;
}) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await signIn(email, password);
      if (result.type === 'newPasswordRequired') {
        onNewPasswordRequired(result);
      }
      // On success, AuthContext's identity state updates and LoginPage redirects on its next
      // render - nothing further to do here.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="login-page__form"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <Input
        id="email"
        label="Email"
        type="email"
        autoComplete="username"
        placeholder="supervisor@mzazicare.org"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Input
        id="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error ? <div className="login-page__error">{error}</div> : null}
      <Button type="submit" variant="primary" disabled={submitting}>
        {submitting ? 'Signing in...' : 'Sign in'}
      </Button>
    </form>
  );
}

// Shown when signing in with a temporary password (always true for a console- or
// AdminCreateUser-created account - the Cognito console has no "set a permanent password" action,
// confirmed against AWS's own AdminSetUserPassword docs). `challenge.requiredAttributes` lists any
// attribute Cognito still needs a value for - this pool only marks `name` (fullname) as required
// (infra/lib/auth.ts), so that's the only one handled here; a user created with a name already set
// won't have it in the list at all, per AWS's documented rule that an already-valued required
// attribute can't be resubmitted in this challenge response.
function NewPasswordForm({ challenge }: { challenge: NewPasswordRequiredResult }) {
  const { completeNewPassword } = useAuth();
  const needsName = challenge.requiredAttributes.includes('name');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await completeNewPassword(challenge, newPassword, needsName ? { name: fullName } : undefined);
      // On success, AuthContext's identity state updates and LoginPage redirects on its next
      // render - nothing further to do here.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the new password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="login-page__form"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <p className="login-page__hint">
        This account has a temporary password. Choose a new password to finish signing in.
      </p>
      {needsName ? (
        <Input
          id="fullName"
          label="Full name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
        />
      ) : null}
      <Input
        id="newPassword"
        label="New password"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        required
      />
      <Input
        id="confirmPassword"
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        required
      />
      {error ? <div className="login-page__error">{error}</div> : null}
      <Button type="submit" variant="primary" disabled={submitting}>
        {submitting ? 'Setting password...' : 'Set password and sign in'}
      </Button>
    </form>
  );
}

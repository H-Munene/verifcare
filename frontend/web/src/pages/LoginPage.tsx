import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, type Location } from 'react-router-dom';
import {
  cognitoErrorCode,
  confirmPasswordReset,
  requestPasswordReset,
  type NewPasswordRequiredResult,
} from '../auth/cognito';
import { showErrorToast } from '../design-system/toastStore';
import { useAuth } from '../auth/AuthContext';
import { Button } from '../design-system/Button';
import { Input, PasswordInput } from '../design-system/Input';
import botanical from '../assets/signin-botanical.jpg';
import './LoginPage.css';

// The pool's password policy (infra/lib/auth.ts leaves Cognito's default), shown under new-password
// fields. Cognito still enforces it and its own message is shown when a password falls short.
const PASSWORD_POLICY_HINT =
  'At least 8 characters, with an upper-case letter, a lower-case letter, a number and a symbol.';

type View =
  | { kind: 'signIn'; notice?: string }
  | { kind: 'newPassword'; challenge: NewPasswordRequiredResult }
  // codeAlreadySent: sign-in found an administrator-reset account, whose code Cognito has already
  // emailed, so the form opens on the code step instead of sending another.
  | { kind: 'reset'; codeAlreadySent: boolean };

export function LoginPage() {
  const { identity } = useAuth();
  const location = useLocation();
  const [view, setView] = useState<View>({ kind: 'signIn' });
  // Shared by the sign-in and reset forms, so switching between them keeps what was typed.
  const [email, setEmail] = useState('');

  if (identity) {
    const from = (location.state as { from?: Location } | null)?.from;
    return <Navigate to={from?.pathname ?? '/'} replace />;
  }

  return (
    // Split layout (2026-10-12): the form on the left, read first; the botanical illustration fills
    // a full-height panel on the right, which suits its tall portrait shape. On narrow screens the
    // illustration becomes a short band above the form.
    <div className="login-page">
      <main className="login-page__main">
        <div className="login-page__wordmark">VERIFCARE</div>
        <div className="login-page__card">
          <h1 className="login-page__title">
            {view.kind === 'reset'
              ? 'Reset your password'
              : view.kind === 'newPassword'
                ? 'Set a new password'
                : 'Welcome back'}
          </h1>
          {view.kind === 'signIn' ? (
            <p className="login-page__subtitle">Sign in to continue.</p>
          ) : null}
          {view.kind === 'newPassword' ? (
            <NewPasswordForm challenge={view.challenge} />
          ) : view.kind === 'reset' ? (
            <ResetPasswordForm
              email={email}
              onEmailChange={setEmail}
              codeAlreadySent={view.codeAlreadySent}
              onDone={() =>
                setView({
                  kind: 'signIn',
                  notice: 'Password changed. Sign in with your new password.',
                })
              }
              onCancel={() => setView({ kind: 'signIn' })}
            />
          ) : (
            <SignInForm
              email={email}
              onEmailChange={setEmail}
              notice={view.notice}
              onNewPasswordRequired={(challenge) => setView({ kind: 'newPassword', challenge })}
              onForgotPassword={(codeAlreadySent) => setView({ kind: 'reset', codeAlreadySent })}
            />
          )}
        </div>
      </main>
      <div className="login-page__art" aria-hidden="true">
        <img src={botanical} alt="" />
      </div>
    </div>
  );
}

function SignInForm({
  email,
  onEmailChange,
  notice,
  onNewPasswordRequired,
  onForgotPassword,
}: {
  email: string;
  onEmailChange: (email: string) => void;
  notice: string | undefined;
  onNewPasswordRequired: (challenge: NewPasswordRequiredResult) => void;
  onForgotPassword: (codeAlreadySent: boolean) => void;
}) {
  const { signIn } = useAuth();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const result = await signIn(email, password);
      if (result.type === 'newPasswordRequired') {
        onNewPasswordRequired(result);
      } else if (result.type === 'passwordResetRequired') {
        onForgotPassword(true);
      }
      // On success, AuthContext's identity state updates and LoginPage redirects on its next
      // render - nothing further to do here.
    } catch (err) {
      // Cognito's own sign-in messages are readable ("Incorrect username or password.", which with
      // user-existence errors prevented also covers an unknown email).
      showErrorToast(err instanceof Error ? err.message : 'Sign in failed.');
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
      {notice ? <div className="login-page__notice">{notice}</div> : null}
      <Input
        id="email"
        label="Email"
        type="email"
        autoComplete="username"
        placeholder="supervisor@mzazicare.org"
        value={email}
        onChange={(e) => onEmailChange(e.target.value)}
        required
      />
      <div className="login-page__password">
        <PasswordInput
          id="password"
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button
          type="button"
          className="login-page__link login-page__link--end"
          onClick={() => onForgotPassword(false)}
          disabled={submitting}
        >
          Forgot password?
        </button>
      </div>
      <Button type="submit" variant="primary" disabled={submitting}>
        {submitting ? 'Signing in...' : 'Sign in'}
      </Button>
    </form>
  );
}

// A message for each way a reset can fail. Cognito's own text is only shown for a password that
// breaks the policy, where it names the missing rule; the rest are written for the user.
function resetErrorText(err: unknown): string {
  switch (cognitoErrorCode(err)) {
    case 'CodeMismatchException':
      return "That code isn't right. Check the email and try again.";
    case 'ExpiredCodeException':
      return 'That code has expired. Use "Send a new code" for another one.';
    case 'InvalidPasswordException': {
      const prefix = 'Password does not conform to policy: ';
      const message = err instanceof Error ? err.message : '';
      return message.startsWith(prefix)
        ? message.slice(prefix.length)
        : `That password isn't allowed. ${PASSWORD_POLICY_HINT}`;
    }
    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
      return 'Too many attempts. Please wait a while, then try again.';
    // Cognito's answer for an account still on the temporary password from its invitation.
    case 'NotAuthorizedException':
      return "This account hasn't been set up yet. Sign in with the temporary password from your invitation email - if it has expired, ask an administrator to send a new one.";
    // No verified email on the account to send a code to.
    case 'InvalidParameterException':
      return "A code can't be sent to this account. Ask an administrator to reset your password.";
    case 'NetworkError':
      return 'Could not reach the server. Check your connection and try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

// Two steps: the email, then the emailed code with the new password typed twice. Everything goes
// straight to Cognito; on success the user signs in with the new password, since
// ConfirmForgotPassword returns no session.
function ResetPasswordForm({
  email,
  onEmailChange,
  codeAlreadySent,
  onDone,
  onCancel,
}: {
  email: string;
  onEmailChange: (email: string) => void;
  codeAlreadySent: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [codeStep, setCodeStep] = useState(codeAlreadySent);
  // Only the administrator's own code - cleared once the user asks for a code themselves.
  const [adminReset, setAdminReset] = useState(codeAlreadySent);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const trimmedEmail = email.trim();

  async function run(action: () => Promise<void>) {
    setNotice(null);
    setSubmitting(true);
    try {
      await action();
    } catch (err) {
      showErrorToast(resetErrorText(err));
    } finally {
      setSubmitting(false);
    }
  }

  function sendCode(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await requestPasswordReset(trimmedEmail);
      setCodeStep(true);
      setAdminReset(false);
    });
  }

  function resendCode() {
    void run(async () => {
      await requestPasswordReset(trimmedEmail);
      setAdminReset(false);
      setNotice('A new code is on its way.');
    });
  }

  function reset(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      showErrorToast('Passwords do not match.');
      return;
    }
    void run(async () => {
      await confirmPasswordReset(trimmedEmail, code.trim(), newPassword);
      onDone();
    });
  }

  if (!codeStep) {
    return (
      <form className="login-page__form" onSubmit={sendCode}>
        <p className="login-page__hint">
          Enter the email you sign in with and we&apos;ll send you a code to reset your password.
        </p>
        <Input
          id="resetEmail"
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          required
          autoFocus
        />
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? 'Sending...' : 'Send code'}
        </Button>
        <button type="button" className="login-page__link" onClick={onCancel} disabled={submitting}>
          Back to sign in
        </button>
      </form>
    );
  }

  return (
    <form className="login-page__form" onSubmit={reset}>
      {/* Worded for both outcomes: an unknown email gets the same response as a known one. */}
      <p className="login-page__hint">
        {adminReset
          ? `Your password was reset. Enter the code we emailed to ${trimmedEmail} and choose a new password.`
          : `If there's an account for ${trimmedEmail}, we've emailed it a code. Enter it below and choose a new password. The code expires in an hour.`}
      </p>
      {notice ? <div className="login-page__notice">{notice}</div> : null}
      <Input
        id="resetCode"
        label="Code"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        required
        autoFocus
      />
      <PasswordInput
        id="resetNewPassword"
        label="New password"
        autoComplete="new-password"
        hint={PASSWORD_POLICY_HINT}
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        required
      />
      <PasswordInput
        id="resetConfirmPassword"
        label="Confirm new password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        required
      />
      <Button type="submit" variant="primary" disabled={submitting}>
        {submitting ? 'Saving...' : 'Reset password'}
      </Button>
      <div className="login-page__links">
        <button
          type="button"
          className="login-page__link"
          onClick={resendCode}
          disabled={submitting}
        >
          Send a new code
        </button>
        <button
          type="button"
          className="login-page__link"
          onClick={() => {
            setCodeStep(false);
            setNotice(null);
          }}
          disabled={submitting}
        >
          Use a different email
        </button>
      </div>
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
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      showErrorToast('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await completeNewPassword(challenge, newPassword, needsName ? { name: fullName } : undefined);
      // On success, AuthContext's identity state updates and LoginPage redirects on its next
      // render - nothing further to do here.
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : 'Could not set the new password.');
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
      <PasswordInput
        id="newPassword"
        label="New password"
        autoComplete="new-password"
        hint={PASSWORD_POLICY_HINT}
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        required
      />
      <PasswordInput
        id="confirmPassword"
        label="Confirm new password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        required
      />
      <Button type="submit" variant="primary" disabled={submitting}>
        {submitting ? 'Setting password...' : 'Set password and sign in'}
      </Button>
    </form>
  );
}

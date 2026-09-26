import {
  useState,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
} from 'react';
import './components.css';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
}

// Inputs share the same 32px height as buttons so toolbars and forms line up (per the design
// system spec) - see components.css's --control-height usage.
export function Input({ label, hint, error, id, className, required, ...rest }: InputProps) {
  const classes = ['ds-input', error ? 'ds-input--error' : undefined, className]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="ds-field">
      {label ? (
        <Label htmlFor={id} required={required}>
          {label}
        </Label>
      ) : null}
      <input id={id} className={classes} required={required} {...rest} />
      {error ? (
        <div className="ds-field__error">{error}</div>
      ) : hint ? (
        <div className="ds-field__hint">{hint}</div>
      ) : null}
    </div>
  );
}

export type PasswordInputProps = Omit<InputProps, 'type'>;

// A password Input with a show/hide toggle, so a password can be checked before it's submitted.
// The toggle is a real button (keyboard-reachable, labelled for screen readers) but type="button",
// so it never submits the form it sits in.
export function PasswordInput({
  label,
  hint,
  error,
  id,
  className,
  required,
  ...rest
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const classes = [
    'ds-input',
    'ds-input--with-toggle',
    error ? 'ds-input--error' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="ds-field">
      {label ? (
        <Label htmlFor={id} required={required}>
          {label}
        </Label>
      ) : null}
      <div className="ds-input-wrap">
        <input
          id={id}
          className={classes}
          required={required}
          type={visible ? 'text' : 'password'}
          {...rest}
        />
        <button
          type="button"
          className="ds-input__toggle"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          title={visible ? 'Hide password' : 'Show password'}
          onClick={() => setVisible((v) => !v)}
        >
          <EyeIcon crossed={visible} />
        </button>
      </div>
      {error ? (
        <div className="ds-field__error">{error}</div>
      ) : hint ? (
        <div className="ds-field__hint">{hint}</div>
      ) : null}
    </div>
  );
}

// Inline rather than an icon package: the design system has no icon dependency, and this is its
// only icon so far.
function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {crossed ? <line x1="3" y1="3" x2="21" y2="21" /> : null}
    </svg>
  );
}

interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
}

// Shared by every "*Input" in the design system and by any raw `<select>`/`<textarea>` field that
// wants the same marker (RegisterDependantPage.tsx's id-type dropdown, for one) - a bare `<label
// className="ds-label">` can render the same `<span className="ds-label__required">` directly
// instead of importing this, since it isn't exported.
export function Label({ children, required, ...rest }: LabelProps) {
  return (
    <label className="ds-label" {...rest}>
      {children}
      {required ? <span className="ds-label__required"> *</span> : null}
    </label>
  );
}

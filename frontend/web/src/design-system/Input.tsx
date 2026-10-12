import type { InputHTMLAttributes, LabelHTMLAttributes, ReactNode } from 'react';
import './components.css';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
}

// Same height as buttons (--control-height).
export function Input({ label, hint, error, id, className, ...rest }: InputProps) {
  const classes = ['ds-input', error ? 'ds-input--error' : undefined, className]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="ds-field">
      {label ? <Label htmlFor={id}>{label}</Label> : null}
      <input id={id} className={classes} {...rest} />
      {error ? (
        <div className="ds-field__error">{error}</div>
      ) : hint ? (
        <div className="ds-field__hint">{hint}</div>
      ) : null}
    </div>
  );
}

function Label({ children, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className="ds-label" {...rest}>
      {children}
    </label>
  );
}

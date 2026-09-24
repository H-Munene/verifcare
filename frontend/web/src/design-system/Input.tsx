import type { InputHTMLAttributes, LabelHTMLAttributes, ReactNode } from 'react';
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

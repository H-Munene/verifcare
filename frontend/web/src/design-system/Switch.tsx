import type { ReactNode } from 'react';
import './components.css';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  hint?: ReactNode;
}

export function Switch({ checked, onChange, label, disabled, hint }: SwitchProps) {
  return (
    <div className="ds-switch-field">
      <label className="ds-switch-row">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={disabled}
          className={`ds-switch ${checked ? 'ds-switch--on' : ''}`}
          onClick={() => onChange(!checked)}
        >
          <span className="ds-switch__thumb" />
        </button>
        {label ? <span>{label}</span> : null}
      </label>
      {hint ? <div className="ds-field__hint">{hint}</div> : null}
    </div>
  );
}

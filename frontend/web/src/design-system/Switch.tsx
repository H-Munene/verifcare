import './components.css';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
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
  );
}

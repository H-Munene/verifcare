import type { ReactNode } from 'react';
import './components.css';

export interface NavItemProps {
  label: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

// The icon is a placeholder square for now.
export function NavItem({ label, active, disabled, onClick }: NavItemProps) {
  const classes = [
    'ds-nav-item',
    active ? 'ds-nav-item--active' : undefined,
    disabled ? 'ds-nav-item--disabled' : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={classes} onClick={onClick} disabled={disabled}>
      <span className="ds-nav-item__icon" aria-hidden="true" />
      <span className="ds-nav-item__label">{label}</span>
    </button>
  );
}

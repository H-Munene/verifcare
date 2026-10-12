import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ReactNode } from 'react';
import './components.css';

export interface NavItemProps {
  label: ReactNode;
  icon: IconSvgElement;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

// 32px height, 16px leading icon (Hugeicons, replacing the wireframe's placeholder squares),
// selected state = accent-tint fill + accent text, square-cornered. The icon takes the row's text colour.
export function NavItem({ label, icon, active, disabled, onClick }: NavItemProps) {
  const classes = [
    'ds-nav-item',
    active ? 'ds-nav-item--active' : undefined,
    disabled ? 'ds-nav-item--disabled' : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={classes} onClick={onClick} disabled={disabled}>
      <HugeiconsIcon
        icon={icon}
        size={16}
        strokeWidth={1.5}
        className="ds-nav-item__icon"
        aria-hidden
      />
      <span className="ds-nav-item__label">{label}</span>
    </button>
  );
}

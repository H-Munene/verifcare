import { useRef, type ReactNode } from 'react';
import type { AnimatedIcon, AnimatedIconHandle } from '../lib/animatedIcon';
import './components.css';

export interface NavItemProps {
  label: ReactNode;
  icon: AnimatedIcon;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

// 32px height, 16px leading icon, selected state = blue-tint fill + blue text. The icon is a
// lucide-animated one (2026-09-26, replacing the wireframe's placeholder squares); it animates
// while the whole row is hovered or keyboard-focused, not only the icon itself, and never on a
// disabled row.
export function NavItem({ label, icon: Icon, active, disabled, onClick }: NavItemProps) {
  const iconRef = useRef<AnimatedIconHandle>(null);
  const classes = [
    'ds-nav-item',
    active ? 'ds-nav-item--active' : undefined,
    disabled ? 'ds-nav-item--disabled' : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  const start = () => {
    if (!disabled) {
      iconRef.current?.startAnimation();
    }
  };
  const stop = () => iconRef.current?.stopAnimation();
  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={start}
      onMouseLeave={stop}
      onFocus={start}
      onBlur={stop}
    >
      <Icon ref={iconRef} size={16} className="ds-nav-item__icon" aria-hidden />
      <span className="ds-nav-item__label">{label}</span>
    </button>
  );
}

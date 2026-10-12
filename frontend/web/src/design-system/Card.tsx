import type { HTMLAttributes } from 'react';
import './components.css';

// Hairline border, no shadow. Shadows are only for floating UI like modals.
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const classes = ['ds-card', className].filter(Boolean).join(' ');
  return <div className={classes} {...rest} />;
}

import type { HTMLAttributes } from 'react';
import './components.css';

// Hairline border, no shadow - "a card sitting directly on white canvas never gets a shadow" per
// the design system spec. Real shadow is reserved for things that float above the page (modals),
// see Modal.tsx.
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const classes = ['ds-card', className].filter(Boolean).join(' ');
  return <div className={classes} {...rest} />;
}

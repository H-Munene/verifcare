import type { ButtonHTMLAttributes } from 'react';
import './components.css';

export type ButtonVariant = 'default' | 'primary' | 'cta-pill';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

// default: secondary actions. primary: the main action in a panel.
// cta-pill: the single main action on a screen; never two on one view.
export function Button({ variant = 'default', className, ...rest }: ButtonProps) {
  const classes = ['ds-button', `ds-button--${variant}`, className].filter(Boolean).join(' ');
  return <button className={classes} {...rest} />;
}

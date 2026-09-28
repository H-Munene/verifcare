import type { ButtonHTMLAttributes } from 'react';
import './components.css';

export type ButtonVariant = 'default' | 'primary' | 'cta-pill';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

// button-default (white, hairline border) is the workhorse for every secondary action.
// button-primary (filled blue) is the one main action in a panel - Save, Apply.
// button-cta-pill is reserved for the single most important action on the whole screen - callers
// are responsible for never rendering two pill buttons on the same view, per the design system
// spec ("never two pill buttons on the same view").
export function Button({ variant = 'default', className, ...rest }: ButtonProps) {
  const classes = ['ds-button', `ds-button--${variant}`, className].filter(Boolean).join(' ');
  return <button className={classes} {...rest} />;
}

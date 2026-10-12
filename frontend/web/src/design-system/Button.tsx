import type { ComponentProps } from 'react';
import './components.css';

export type ButtonVariant = 'default' | 'primary' | 'cta-pill';

// ComponentProps (not ButtonHTMLAttributes) so a caller can pass a ref, e.g. to focus it.
export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
}

// default: secondary actions. primary: the main action in a panel.
// cta-pill: the single main action on a screen; never two on one view.
export function Button({ variant = 'default', className, ...rest }: ButtonProps) {
  const classes = ['ds-button', `ds-button--${variant}`, className].filter(Boolean).join(' ');
  return <button className={classes} {...rest} />;
}

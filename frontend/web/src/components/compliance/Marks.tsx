import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ReactNode } from 'react';

// Small marks the Compliance reports share. A problem is never shown by colour alone: each mark
// pairs an icon with its text, so it reads the same to a colour-blind supervisor and in print.

/** A count that needs attention: an icon and the number when above zero, a muted 0 otherwise. */
export function Flag({
  count,
  icon,
  label,
}: {
  count: number;
  icon: IconSvgElement;
  label: string;
}) {
  if (count === 0) {
    return <span className="compliance__zero">0</span>;
  }
  return (
    <span className="compliance__flag" title={`${count} ${label}`}>
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.6} aria-hidden />
      {count}
    </span>
  );
}

/** A state with its icon, in the tone that says whether it's fine, a problem, or neither. */
export function StateMark({
  icon,
  tone,
  children,
}: {
  icon: IconSvgElement;
  tone: 'ok' | 'problem' | 'muted';
  children: ReactNode;
}) {
  return (
    <span className={`compliance__state compliance__state--${tone}`}>
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.6} aria-hidden />
      {children}
    </span>
  );
}

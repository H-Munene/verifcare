// A visit state as an icon (2026-09-26, user request): a green tick for checked in, a circle with
// a dash for awaiting check-in, a red cross for no check-in, and a grey clock for upcoming. The
// state's name is the accessible label, since the icon alone is colour and shape.

import {
  Cancel01Icon,
  Clock01Icon,
  MinusSignCircleIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { VisitState } from '../api/dashboard';
import { STATE_META } from './visitStates';

const ICONS = {
  upcoming: { icon: Clock01Icon, color: 'var(--color-state-upcoming-icon)' },
  awaiting_checkin: { icon: MinusSignCircleIcon, color: 'var(--color-state-awaiting-icon)' },
  checked_in: { icon: Tick02Icon, color: 'var(--color-state-checked-in-icon)' },
  no_checkin: { icon: Cancel01Icon, color: 'var(--color-state-no-checkin-icon)' },
} as const;

export function StateIcon({ state, size = 18 }: { state: VisitState; size?: number }) {
  const { icon, color } = ICONS[state];
  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      strokeWidth={2}
      color={color}
      role="img"
      aria-label={STATE_META[state].label}
    />
  );
}

// A visit state as an icon (2026-09-26, user request): a green check for checked in, a dashed
// circle for awaiting check-in, a red cross for no check-in, and a grey clock for upcoming. The
// lucide-animated icons play their animation once when shown, so a newly opened summary draws
// attention to the state; MotionConfig in main.tsx skips it for reduced-motion users. The state's
// name is the accessible label, since the icon alone is colour and shape.

import { useEffect, useRef } from 'react';
import type { VisitState } from '../api/dashboard';
import { CheckIcon } from '@/components/icons/check';
import { CircleDashedIcon } from '@/components/icons/circle-dashed';
import { ClockIcon } from '@/components/icons/clock';
import { XIcon } from '@/components/icons/x';
import { STATE_META } from './visitStates';

interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

const ICONS = {
  upcoming: { Icon: ClockIcon, color: 'var(--color-state-upcoming-icon)' },
  awaiting_checkin: { Icon: CircleDashedIcon, color: 'var(--color-state-awaiting-icon)' },
  checked_in: { Icon: CheckIcon, color: 'var(--color-state-checked-in-icon)' },
  no_checkin: { Icon: XIcon, color: 'var(--color-state-no-checkin-icon)' },
} as const;

export function StateIcon({ state, size = 18 }: { state: VisitState; size?: number }) {
  const ref = useRef<AnimatedIconHandle>(null);
  const { Icon, color } = ICONS[state];

  useEffect(() => {
    ref.current?.startAnimation();
  }, [state]);

  return (
    <Icon
      ref={ref}
      size={size}
      role="img"
      aria-label={STATE_META[state].label}
      title={STATE_META[state].label}
      style={{ color, display: 'inline-flex', lineHeight: 0 }}
    />
  );
}

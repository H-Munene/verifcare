// The four visit outcomes the Overview counts, in stacking order (bottom up), shared by the
// outcome summary and the 14-day chart so both name, colour and explain them the same way.

import {
  Cancel01Icon,
  Clock01Icon,
  MinusSignCircleIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import type { TrendDay } from '../api/dashboard';

export type OutcomeKey = 'completed' | 'missed' | 'open' | 'cancelled';

export interface OutcomeSeries {
  key: OutcomeKey;
  label: string;
  /** What the outcome means, in the supervisor's words. */
  explanation: string;
  color: string;
  icon: IconSvgElement;
}

export const OUTCOME_SERIES: readonly OutcomeSeries[] = [
  {
    key: 'completed',
    label: 'Completed',
    explanation: 'Checked in and checked out',
    color: 'var(--color-state-checked-in)',
    icon: Tick02Icon,
  },
  {
    key: 'missed',
    label: 'Missed',
    explanation: 'Ended with no check-in',
    color: 'var(--color-state-no-checkin)',
    icon: Cancel01Icon,
  },
  {
    key: 'open',
    label: 'Not finished yet',
    explanation: 'Still to come, or in progress',
    color: 'var(--color-state-upcoming)',
    icon: Clock01Icon,
  },
  {
    key: 'cancelled',
    label: 'Cancelled',
    explanation: 'Called off before the visit',
    color: 'var(--color-state-cancelled)',
    icon: MinusSignCircleIcon,
  },
];

export function dayTotal(day: TrendDay): number {
  return day.completed + day.missed + day.open + day.cancelled;
}

/** A calendar date as text, e.g. "Sep 26"; noon UTC keeps the date the same in every zone. */
export function dayLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    ...options,
    timeZone: 'UTC',
  });
}

// The four visit outcomes the Overview counts, in stacking order (bottom up), shared by the
// outcome summary and the 14-day chart so both name, colour and explain them the same way.

import type { TrendDay } from '../api/dashboard';

export type OutcomeKey = 'completed' | 'missed' | 'open' | 'cancelled';

export interface OutcomeSeries {
  key: OutcomeKey;
  label: string;
  color: string;
}

export const OUTCOME_SERIES: readonly OutcomeSeries[] = [
  {
    key: 'completed',
    label: 'Completed',
    color: 'var(--color-state-checked-in)',
  },
  {
    key: 'missed',
    label: 'Missed',
    color: 'var(--color-state-no-checkin)',
  },
  {
    key: 'open',
    label: 'Not finished yet',
    color: 'var(--color-state-upcoming)',
  },
  {
    key: 'cancelled',
    label: 'Cancelled',
    color: 'var(--color-state-cancelled)',
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

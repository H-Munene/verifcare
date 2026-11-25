// The Compliance tab reports by calendar month (the exports are monthly reports), kept in the URL
// as `?month=YYYY-MM` and sent to the API as the month's first and last Nairobi day.

import type { Period } from '../../api/compliance';
import { todayInNairobi } from '../visitStates';

export function currentMonth(): string {
  return todayInNairobi().slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  const [year = 0, m = 1] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

export function monthPeriod(month: string): Period {
  const last = new Date(`${shiftMonth(month, 1)}-01T00:00:00Z`);
  last.setUTCDate(0);
  return { from: `${month}-01`, to: last.toISOString().slice(0, 10) };
}

/** "September 2026". */
export function monthLabel(month: string): string {
  return new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-KE', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** This month and the [count] - 1 before it, newest first, for the month picker. */
export function recentMonths(count = 24): string[] {
  const now = currentMonth();
  return Array.from({ length: count }, (_, i) => shiftMonth(now, -i));
}

/** A valid `YYYY-MM` no later than this month, else this month - a hand-edited URL can't break it. */
export function parseMonth(value: string): string {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value <= currentMonth() ? value : currentMonth();
}

const dayMonth = (iso: string, withMonth = true) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-KE', {
    day: 'numeric',
    ...(withMonth ? { month: 'short' } : {}),
    timeZone: 'UTC',
  });

/** "2–8 Nov", "30 Nov – 6 Dec", or "30 Nov": the week, cut to the report's month. */
export function weekRange(weekStart: string, period: Period): string {
  const last = new Date(`${weekStart}T12:00:00Z`);
  last.setUTCDate(last.getUTCDate() + 6);
  const from = weekStart < period.from ? period.from : weekStart;
  const lastDay = last.toISOString().slice(0, 10);
  const to = lastDay > period.to ? period.to : lastDay;
  if (from === to) {
    return dayMonth(from);
  }
  return from.slice(0, 7) === to.slice(0, 7)
    ? `${dayMonth(from, false)}–${dayMonth(to)}`
    : `${dayMonth(from)} – ${dayMonth(to)}`;
}

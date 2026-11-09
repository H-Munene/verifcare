// Formatting shared by the Compliance tab's reports. Times are Nairobi times, as everywhere in the
// console (components/visitStates.ts), so a report reads the same whoever's browser opens it.

import type { ExceptionKind } from '../../api/compliance';

const TIME_ZONE = 'Africa/Nairobi';

/** "Thu 10 Sep, 9:15 am". */
export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-KE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: TIME_ZONE,
  });
}

/** "10 Sep 2026". */
export function date(iso: string): string {
  return new Date(iso).toLocaleDateString('en-KE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: TIME_ZONE,
  });
}

/** "67%", or "-" when there's nothing to divide yet. */
export function percent(rate: number | null): string {
  return rate === null ? '-' : `${Math.round(rate * 100)}%`;
}

/** "12 min", "3 h 05 min", "2 d 4 h", or "-". */
export function minutes(value: number | null): string {
  if (value === null) {
    return '-';
  }
  const total = Math.round(value);
  if (total < 60) {
    return `${total} min`;
  }
  if (total < 24 * 60) {
    return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')} min`;
  }
  return `${Math.floor(total / 1440)} d ${Math.floor((total % 1440) / 60)} h`;
}

export const EXCEPTION_KIND_LABELS: Record<ExceptionKind, string> = {
  missed: 'Missed',
  missing_checkout: 'No checkout',
  failed_check: 'Failed check',
  supervisor_override: 'Supervisor override',
};

const ATTEMPT_LABELS: Record<string, string> = {
  geofence: 'Location',
  family_location: 'Family phone location',
  qr_scan: 'Code scan',
};

/** "Location: out of range (2)". */
export function failedCheckLabel(check: {
  attemptType: string;
  failureReason: string | null;
  count: number;
}): string {
  const what = ATTEMPT_LABELS[check.attemptType] ?? check.attemptType;
  const why = check.failureReason ? check.failureReason.replaceAll('_', ' ') : 'failed';
  return `${what}: ${why}${check.count > 1 ? ` (${check.count})` : ''}`;
}

/** "visit_schedule.update" -> "Visit schedule update". */
export function humanise(code: string): string {
  const text = code.replaceAll('.', ' ').replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

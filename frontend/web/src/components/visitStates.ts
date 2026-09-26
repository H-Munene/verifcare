// The Overview's visit states in one place, so the status tiles, the map's dots and tooltip, and
// the day's visit list always name and colour a state the same way.

import type { VisitState } from '../api/dashboard';

export const VISIT_STATES: readonly VisitState[] = [
  'upcoming',
  'awaiting_checkin',
  'checked_in',
  'no_checkin',
];

export const STATE_META: Record<VisitState, { label: string; color: string }> = {
  upcoming: { label: 'Upcoming', color: 'var(--color-state-upcoming)' },
  awaiting_checkin: { label: 'Awaiting check-in', color: 'var(--color-state-awaiting)' },
  checked_in: { label: 'Checked in', color: 'var(--color-state-checked-in)' },
  no_checkin: { label: 'No check-in', color: 'var(--color-state-no-checkin)' },
};

// Google Maps symbols can't read CSS variables, so the map takes the literal values of the same
// tokens (design-system/tokens.css).
export const STATE_HEX: Record<VisitState, string> = {
  upcoming: '#a0a4ab',
  awaiting_checkin: '#ffc107',
  checked_in: '#00c16a',
  no_checkin: '#e8262d',
};

// When one home has several visits that day, its dot shows the one most needing a supervisor.
const URGENCY: Record<VisitState, number> = {
  no_checkin: 3,
  awaiting_checkin: 2,
  checked_in: 1,
  upcoming: 0,
};

export function mostUrgent(states: VisitState[]): VisitState {
  return states.reduce((a, b) => (URGENCY[b] > URGENCY[a] ? b : a));
}

/** Clock time in the service's time zone (the backend's "day" is a Nairobi day). */
export function formatTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
}

// How a visit turned out, by the user's own definitions (2026-09-26). Lives on its own, rather
// than in routes/dashboard.ts where it started, since the dashboard and the per-person stats
// (db/visitStats.ts) must count visits identically.

/**
 * Where a visit stands, as the Overview map colours it (user's definitions, 2026-09-26):
 * - upcoming: not checked in, and its start time hasn't come yet (grey)
 * - awaiting_checkin: not checked in, and now is between its start and end (amber)
 * - checked_in: the caregiver checked in, whether or not they've checked out since (green)
 * - no_checkin: its end time passed with no check-in, or it was marked missed (red)
 * A visit marked missed or investigated is red even if the missed-visit sweep ran before its end
 * time; the time rule alone also catches a visit the sweep hasn't reached yet, so the map never
 * waits on the sweep to show a visit nobody turned up for.
 */
export type VisitState = 'upcoming' | 'awaiting_checkin' | 'checked_in' | 'no_checkin';

export function visitState(
  visit: { status: string; scheduledStart: Date; scheduledEnd: Date; checkinAt: Date | null },
  now: Date,
): VisitState {
  if (visit.checkinAt) {
    return 'checked_in';
  }
  if (visit.status === 'missed' || visit.status === 'investigated' || now > visit.scheduledEnd) {
    return 'no_checkin';
  }
  return now < visit.scheduledStart ? 'upcoming' : 'awaiting_checkin';
}

/** The trend chart's outcome for one visit: the map's state, with checked-out visits completed. */
export type TrendOutcome = 'completed' | 'missed' | 'cancelled' | 'open';

export function trendOutcome(
  visit: Parameters<typeof visitState>[0] & { checkoutAt: Date | null },
  now: Date,
): TrendOutcome {
  if (visit.status === 'cancelled') {
    return 'cancelled';
  }
  const state = visitState(visit, now);
  if (state === 'no_checkin') {
    return 'missed';
  }
  // Checked in but not out yet (or never checked out) is still open, not a completed visit.
  return state === 'checked_in' && (visit.checkoutAt || visit.status === 'completed')
    ? 'completed'
    : 'open';
}

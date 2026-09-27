import { Link } from 'react-router-dom';
import type { VisitStats } from '../api/visitStats';
import { Skeleton, SkeletonRegion } from '../design-system/Skeleton';
import './VisitStatsTiles.css';

// A person's visits at a glance on their detail page (2026-09-27, user request): the Overview's
// hairline grid of tiles (label, big figure, one line of detail), fed by the per-person stats
// endpoint. Shared by the dependant and caregiver pages; `perspective` only changes who the
// "other person" on a visit is - the caregiver for a dependant, the dependant for a caregiver.
//
// Five figures, chosen as what a supervisor checks first about someone's care: how many visits
// happened lately, how reliably they happened, how many were missed (and when the last one was),
// and when the next and most recent visits are.

const TIME_ZONE = 'Africa/Nairobi';

function nairobiDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(date);
}

/** "Today, 10:00", "Tomorrow, 10:00", "Yesterday, 09:04", else "Mon 29 Sep, 10:00". */
function relativeDateTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const day = nairobiDay(date);
  const offset = (days: number) => nairobiDay(new Date(now.getTime() + days * 86400000));
  const time = date.toLocaleTimeString('en-KE', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIME_ZONE,
  });
  const dayLabel =
    day === offset(0)
      ? 'Today'
      : day === offset(1)
        ? 'Tomorrow'
        : day === offset(-1)
          ? 'Yesterday'
          : date.toLocaleDateString('en-KE', {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              timeZone: TIME_ZONE,
            });
  return `${dayLabel}, ${time}`;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-KE', {
    day: 'numeric',
    month: 'short',
    timeZone: TIME_ZONE,
  });
}

function duration(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export interface VisitStatsTilesProps {
  stats: VisitStats | undefined;
  isLoading: boolean;
  isError: boolean;
  perspective: 'dependant' | 'caregiver';
}

export function VisitStatsTiles({ stats, isLoading, isError, perspective }: VisitStatsTilesProps) {
  if (isLoading) {
    return (
      <SkeletonRegion label="Loading visit statistics" className="visit-stats">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="visit-stats__tile">
            <Skeleton width={110} height={13} />
            <Skeleton
              width={i < 3 ? 48 : 120}
              height={i < 3 ? 34 : 22}
              style={{ margin: '4px 0' }}
            />
            <Skeleton width={140} height={12} />
          </div>
        ))}
      </SkeletonRegion>
    );
  }
  if (isError || !stats) {
    return <p className="visit-stats__error">Visit statistics couldn&rsquo;t be loaded.</p>;
  }

  const { visits, windowDays } = stats;
  const decided = visits.completed + visits.missed;
  const other = (visit: { caregiverName: string; dependantName: string }) =>
    perspective === 'dependant' ? visit.caregiverName : visit.dependantName;
  const otherPrefix = perspective === 'dependant' ? 'with' : 'at';

  const doneParts = [
    visits.completed ? `${visits.completed} completed` : '',
    visits.open ? `${visits.open} under way` : '',
    visits.cancelled ? `${visits.cancelled} cancelled` : '',
  ].filter(Boolean);

  return (
    <section className="visit-stats" aria-label="Visit statistics">
      <div className="visit-stats__tile">
        <span className="visit-stats__label">Visits, last {windowDays} days</span>
        <span className="visit-stats__figure">{visits.total}</span>
        <span className="visit-stats__detail">
          {visits.total === 0 ? 'None in this period' : doneParts.join(' · ') || 'None completed'}
        </span>
      </div>

      <div className="visit-stats__tile">
        <span className="visit-stats__label">Completion rate</span>
        <span className="visit-stats__figure">
          {stats.completionRate === null ? '-' : `${Math.round(stats.completionRate * 100)}%`}
        </span>
        <span className="visit-stats__detail">
          {decided === 0
            ? 'Nothing due yet'
            : `${visits.completed} of ${decided} due visits completed`}
        </span>
      </div>

      <div className="visit-stats__tile">
        <span className="visit-stats__label">
          <span
            className={`visit-stats__dot${visits.missed ? ' visit-stats__dot--missed' : ''}`}
            aria-hidden
          />
          Missed visits
        </span>
        <span className="visit-stats__figure">{visits.missed}</span>
        <span className="visit-stats__detail">
          {stats.lastMissedVisitStart
            ? `Most recent ${shortDate(stats.lastMissedVisitStart)}`
            : `None in the last ${windowDays} days`}
        </span>
      </div>

      <div className="visit-stats__tile">
        <span className="visit-stats__label">Next visit</span>
        {stats.nextVisit ? (
          <>
            <Link to={`/visits/${stats.nextVisit.id}`} className="visit-stats__when">
              {relativeDateTime(stats.nextVisit.scheduledStart)}
            </Link>
            <span className="visit-stats__detail">
              {otherPrefix} {other(stats.nextVisit)}
            </span>
          </>
        ) : (
          <>
            <span className="visit-stats__when visit-stats__when--none">None scheduled</span>
            <span className="visit-stats__detail">Nothing booked yet</span>
          </>
        )}
      </div>

      <div className="visit-stats__tile">
        <span className="visit-stats__label">Last visit</span>
        {stats.lastVisit ? (
          <>
            <Link to={`/visits/${stats.lastVisit.id}`} className="visit-stats__when">
              {relativeDateTime(stats.lastVisit.checkinAt)}
            </Link>
            <span className="visit-stats__detail">
              {otherPrefix} {other(stats.lastVisit)} ·{' '}
              {stats.lastVisit.checkoutAt
                ? duration(stats.lastVisit.checkinAt, stats.lastVisit.checkoutAt)
                : 'still under way'}
            </span>
          </>
        ) : (
          <>
            <span className="visit-stats__when visit-stats__when--none">No visits yet</span>
            <span className="visit-stats__detail">No check-in recorded</span>
          </>
        )}
      </div>
    </section>
  );
}

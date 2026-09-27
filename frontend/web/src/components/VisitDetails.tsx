// One visit's details (2026-09-27): its status and times as key facts, a small map with the
// dependant's home and where the caregiver checked in, and the check-in timeline. Shown in the
// Visits page's side panel (the user's temp_images/sidepanel.png and timeline_ui.png) and on the
// full visit page, so both always match.

import { useQuery } from '@tanstack/react-query';
import { useApi } from '../api/useApi';
import type {
  VerificationAttempt,
  VerificationAttemptType,
  VisitSchedule,
} from '../api/visitSchedules';
import { Badge } from '../design-system/Badge';
import { Skeleton, SkeletonRegion } from '../design-system/Skeleton';
import { Timeline, type TimelineStep } from '../design-system/Timeline';
import { VisitLocationMap } from './VisitLocationMap';
import './VisitDetails.css';
import { statusLabel, statusTone } from './visitStatus';

function formatWindow(visit: VisitSchedule): string {
  const start = new Date(visit.scheduledStart);
  const end = new Date(visit.scheduledEnd);
  const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${start.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })}, ${start.toLocaleTimeString(undefined, time)} to ${end.toLocaleTimeString(undefined, time)}`;
}

const ATTEMPT_LABELS: Record<VerificationAttemptType, string> = {
  geofence: 'location',
  caregiver_liveness: 'caregiver photo',
  dependant_liveness: 'dependant photo',
};

/** A step's time is its first passing attempt; failures before it become the step's detail. */
function attemptStep(
  label: string,
  attempts: VerificationAttempt[],
  type: VerificationAttemptType,
): TimelineStep {
  const ofType = attempts.filter((a) => a.attemptType === type);
  const passed = ofType.find((a) => a.passed);
  const failures = ofType.filter((a) => !a.passed);
  const lastReason = failures.at(-1)?.failureReason;
  return {
    label,
    timestamp: passed?.attemptedAt ?? null,
    detail:
      failures.length > 0
        ? `${failures.length} failed ${ATTEMPT_LABELS[type]} ${
            failures.length === 1 ? 'check' : 'checks'
          }${lastReason ? `: ${lastReason.replaceAll('_', ' ')}` : ''}`
        : undefined,
  };
}

export function VisitDetails({ visit }: { visit: VisitSchedule }) {
  const { visitSchedules, dependants } = useApi();
  const verificationQuery = useQuery({
    queryKey: ['visit-schedule', visit.id, 'verification'],
    queryFn: () => visitSchedules.getVisitVerification(visit.id),
  });
  // The visit carries the dependant's name only; the home location comes from their record.
  const dependantQuery = useQuery({
    queryKey: ['dependant', visit.dependantId],
    queryFn: () => dependants.getDependant(visit.dependantId),
  });

  const event = verificationQuery.data?.event ?? null;
  const attempts = verificationQuery.data?.attempts ?? [];
  const dependant = dependantQuery.data;
  const checkin =
    event?.checkinGpsLat != null && event.checkinGpsLng != null
      ? { lat: event.checkinGpsLat, lng: event.checkinGpsLng }
      : null;

  const steps: TimelineStep[] = [
    attemptStep('Arrived at the home', attempts, 'geofence'),
    attemptStep('Caregiver photo verified', attempts, 'caregiver_liveness'),
    attemptStep('Dependant photo verified', attempts, 'dependant_liveness'),
    { label: 'Checked in', timestamp: event?.checkinAt ?? null },
    { label: 'Checked out', timestamp: event?.checkoutAt ?? null },
  ];

  return (
    <div className="visit-details">
      <dl className="visit-details__facts">
        <div>
          <dt>Status</dt>
          <dd>
            <Badge tone={statusTone(visit.status)}>{statusLabel(visit.status)}</Badge>
          </dd>
        </div>
        <div>
          <dt>Scheduled</dt>
          <dd>{formatWindow(visit)}</dd>
        </div>
        <div>
          <dt>Caregiver</dt>
          <dd>{visit.caregiverDisplayName}</dd>
        </div>
        <div>
          <dt>Dependant</dt>
          <dd>{visit.dependantDisplayName}</dd>
        </div>
      </dl>

      <section className="visit-details__section" aria-labelledby="visit-details-map">
        <h3 id="visit-details-map" className="visit-details__heading">
          Location
        </h3>
        {dependant ? (
          <>
            <VisitLocationMap
              home={{ lat: dependant.geofenceLat, lng: dependant.geofenceLng }}
              radiusMeters={dependant.geofenceRadiusMeters}
              checkin={checkin}
            />
            <ul className="visit-details__legend">
              <li>
                <span className="visit-details__pin visit-details__pin--home" aria-hidden />
                {dependant.fullName}'s home
                {dependant.homeAddressText ? `, ${dependant.homeAddressText}` : ''}
              </li>
              <li>
                <span className="visit-details__pin visit-details__pin--checkin" aria-hidden />
                {checkin
                  ? `Where the caregiver checked in${
                      event?.distanceFromGeofenceMeters != null
                        ? `, ${Math.round(event.distanceFromGeofenceMeters)} m from the home`
                        : ''
                    }`
                  : 'The caregiver has not checked in yet'}
              </li>
            </ul>
          </>
        ) : dependantQuery.isError ? (
          <p className="visit-details__message">The home location couldn't be loaded.</p>
        ) : (
          <SkeletonRegion label="Loading the map">
            <Skeleton height={220} radius={0} />
          </SkeletonRegion>
        )}
      </section>

      <section className="visit-details__section" aria-labelledby="visit-details-timeline">
        <h3 id="visit-details-timeline" className="visit-details__heading">
          Timeline
        </h3>
        {verificationQuery.isLoading ? (
          <SkeletonRegion label="Loading the timeline">
            <div className="visit-details__timeline-skeleton">
              {[70, 55, 62, 48, 58].map((width, i) => (
                <Skeleton key={i} width={`${width}%`} height={14} />
              ))}
            </div>
          </SkeletonRegion>
        ) : verificationQuery.isError ? (
          <p className="visit-details__message">The timeline couldn't be loaded.</p>
        ) : (
          <Timeline steps={steps} />
        )}
      </section>
    </div>
  );
}

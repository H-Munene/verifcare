// One visit's details in the side panel (2026-09-27): its key facts, a small map with the
// dependant's home (its pin showing how the visit went), and the check-in timeline. VisitPanel shows it wherever a visit is opened.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { RESOLUTION_OUTCOME_LABELS } from '../api/compliance';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import type {
  AudioSkipReason,
  CheckoutOverrideReason,
  VerificationAttempt,
  VerificationAttemptType,
  VisitRecording,
  VisitSchedule,
  VoiceCheckResult,
} from '../api/visitSchedules';
import { Badge } from '../design-system/Badge';
import { Skeleton, SkeletonRegion } from '../design-system/Skeleton';
import { Timeline, type TimelineStep } from '../design-system/Timeline';
import { VisitLocationMap, type HomeState } from './VisitLocationMap';
import { VisitResolutionSection } from './VisitResolutionSection';
import { statusLabel, statusTone } from './visitStatus';
import './VisitDetails.css';

// Explicit am/pm (user request), rather than whatever the browser's locale prefers.
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12: true };

const AUDIO_SKIP_LABELS: Record<AudioSkipReason, string> = {
  dependant_declined: 'Dependant preferred not to be recorded',
  dependant_unwell_or_asleep: 'Dependant unwell or asleep',
  technical_problem: 'Technical problem',
  other: 'Other reason',
};

const ATTEMPT_LABELS: Record<VerificationAttemptType, string> = {
  geofence: 'location',
  family_location: 'family phone location',
  qr_scan: 'code scan',
  checkin_code: 'code entry',
  checkout_qr: 'check-out code scan',
  checkout_code: 'check-out code entry',
};

const OVERRIDE_LABELS: Record<CheckoutOverrideReason, string> = {
  no_family_member_present: 'No family member was there',
  family_phone_unavailable: "The family member's phone wasn't available",
  camera_or_code_problem: "The code wouldn't scan or wasn't accepted",
  other: 'Other reason',
};

const VOICE_LABELS: Record<VoiceCheckResult, string> = {
  match: 'Voice matches',
  mismatch: "Voice doesn't match",
  too_short: 'Too little speech to check',
  not_enrolled: 'Not checked: no voice recorded yet',
  no_consent: 'Not checked: no consent',
  unavailable: 'Not checked: the check was unavailable',
};

/** "20 s. Voice match score 0.71", the same wording for a match or a mismatch. */
function recordingSummary(recording: VisitRecording): string {
  const check = recording.voiceCheck;
  const result = !check
    ? 'Not checked'
    : check.score != null
      ? `Voice match score ${check.score.toFixed(2)}`
      : VOICE_LABELS[check.result];
  return `${recording.durationSeconds} s. ${result}`;
}

/** How the visit went, for the home pin and the timeline. */
function visitOutcome(visit: VisitSchedule, checkedIn: boolean, now: number): HomeState {
  if (visit.status === 'completed') {
    return 'completed';
  }
  if (visit.status === 'in_progress') {
    return 'ongoing';
  }
  if (visit.status === 'cancelled' || visit.status === 'reassigned') {
    return 'cancelled';
  }
  // Marked missed, or its end has passed with no check-in (the Overview's rule), is missed.
  const over = now > Date.parse(visit.scheduledEnd);
  if (visit.status === 'missed' || visit.status === 'investigated' || (over && !checkedIn)) {
    return 'missed';
  }
  return 'scheduled';
}

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
  const { identity } = useAuth();
  // The time the panel opened, read once: whether a step "won't happen now" depends on it.
  const [now] = useState(() => Date.now());
  const verificationQuery = useQuery({
    queryKey: ['visit-schedule', visit.id, 'verification'],
    queryFn: () => visitSchedules.getVisitVerification(visit.id),
  });
  // The visit carries the dependant's name only; the home and address come from their record.
  const dependantQuery = useQuery({
    queryKey: ['dependant', visit.dependantId],
    queryFn: () => dependants.getDependant(visit.dependantId),
  });

  const event = verificationQuery.data?.event ?? null;
  const attempts = verificationQuery.data?.attempts ?? [];
  const resolutions = verificationQuery.data?.resolutions ?? [];
  const exceptionKinds = verificationQuery.data?.exceptionKinds ?? [];
  const dependant = dependantQuery.data;
  const outcome = visitOutcome(visit, Boolean(event?.checkinAt), now);
  // Over: nothing more will happen, so a step without a time now won't happen.
  const over =
    ['completed', 'missed', 'investigated', 'cancelled', 'reassigned'].includes(visit.status) ||
    now > Date.parse(visit.scheduledEnd);

  const steps: TimelineStep[] = [
    attemptStep('Arrived at the home', attempts, 'geofence'),
    {
      ...(event?.checkinMethod === 'code'
        ? attemptStep('Family code typed in', attempts, 'checkin_code')
        : attemptStep('Family code scanned', attempts, 'qr_scan')),
      ...(event?.checkinMethod === 'supervisor_override'
        ? { label: 'Started by a supervisor', timestamp: event.checkinAt }
        : {}),
    },
    { label: 'Asked to check out', timestamp: event?.checkoutRequestedAt ?? null },
    {
      ...attemptStep(
        event?.checkoutMethod === 'override'
          ? "Checked out without the family's code"
          : 'Checked out with the family code',
        attempts,
        event?.checkoutMethod === 'code' ? 'checkout_code' : 'checkout_qr',
      ),
      // Visits checked out before family confirmation existed have only a check-out time.
      timestamp: event?.checkoutAt ?? null,
      ...(event?.checkoutMethod === 'override' && event.checkoutOverrideReason
        ? {
            detail: `${OVERRIDE_LABELS[event.checkoutOverrideReason]}${
              event.checkoutOverrideNote ? `: ${event.checkoutOverrideNote}` : ''
            }`,
          }
        : {}),
    },
  ].map((step) => ({
    ...step,
    // A missed visit crosses out every step; otherwise, once it's over, only the ones that
    // didn't happen (e.g. checked in but never checked out).
    state:
      outcome === 'missed' && !event?.checkinAt
        ? 'skipped'
        : step.timestamp
          ? 'done'
          : over
            ? 'skipped'
            : 'pending',
  }));
  // The latest resolution closes the story (Compliance tab, 2026-09-27).
  const latestResolution = resolutions[0];
  if (latestResolution) {
    steps.push({
      label: `Resolved: ${RESOLUTION_OUTCOME_LABELS[latestResolution.outcome]}`,
      timestamp: latestResolution.resolvedAt,
      state: 'done',
      detail: `${latestResolution.resolvedByName}: ${latestResolution.note}`,
    });
  }

  const start = new Date(visit.scheduledStart);
  const end = new Date(visit.scheduledEnd);
  const address = dependant
    ? [
        dependant.homeAddressText,
        [dependant.ward, dependant.constituency, dependant.county].filter(Boolean).join(', '),
      ]
        .filter(Boolean)
        .join('\n')
    : null;

  return (
    <div className="visit-details">
      {/* Key facts, each value in bold (user request); the scheduled time split into its parts. */}
      <dl className="visit-details__facts">
        <div>
          <dt>Status</dt>
          <dd>
            <Badge tone={statusTone(visit.status)}>{statusLabel(visit.status)}</Badge>
          </dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>
            {start.toLocaleDateString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </dd>
        </div>
        <div>
          <dt>Starts</dt>
          <dd>{start.toLocaleTimeString(undefined, TIME)}</dd>
        </div>
        <div>
          <dt>Ends</dt>
          <dd>{end.toLocaleTimeString(undefined, TIME)}</dd>
        </div>
        <div>
          <dt>Caregiver</dt>
          <dd>{visit.caregiverDisplayName}</dd>
        </div>
        <div>
          <dt>Dependant</dt>
          <dd>{visit.dependantDisplayName}</dd>
        </div>
        <div className="visit-details__wide">
          <dt>Home address</dt>
          <dd className="visit-details__address">
            {address ?? (dependantQuery.isLoading ? <Skeleton width="70%" height={14} /> : '-')}
          </dd>
        </div>
        {event?.distanceFromGeofenceMeters != null ? (
          <div className="visit-details__wide">
            <dt>Checked in</dt>
            <dd>{Math.round(event.distanceFromGeofenceMeters)} m from the home</dd>
          </div>
        ) : null}
        {event?.qrFamilyMemberName ? (
          <div className="visit-details__wide">
            <dt>Confirmed by</dt>
            <dd>{event.qrFamilyMemberName}</dd>
          </div>
        ) : null}
        {(['caregiver', 'dependant'] as const).map((role) => {
          const recording = event?.recordings.find((r) => r.role === role);
          const label = role === 'caregiver' ? "Caregiver's voice" : "Dependant's voice";
          if (recording) {
            return (
              <div key={role} className="visit-details__wide">
                <dt>{label}</dt>
                <dd>{recordingSummary(recording)}</dd>
              </div>
            );
          }
          return role === 'dependant' && event?.audioSkipReason ? (
            <div key={role} className="visit-details__wide">
              <dt>{label}</dt>
              <dd>
                Not recorded: {AUDIO_SKIP_LABELS[event.audioSkipReason]}
                {event.audioSkipNote ? ` (${event.audioSkipNote})` : ''}
              </dd>
            </div>
          ) : null;
        })}
        {event?.checkoutMethod ? (
          <div className="visit-details__wide">
            <dt>Checked out</dt>
            <dd>
              {event.checkoutMethod === 'override'
                ? `Without the family's code: ${
                    event.checkoutOverrideReason
                      ? OVERRIDE_LABELS[event.checkoutOverrideReason]
                      : 'no reason recorded'
                  }${event.checkoutOverrideNote ? ` (${event.checkoutOverrideNote})` : ''}`
                : `Confirmed by ${event.checkoutFamilyMemberName ?? 'a family member'}, code ${
                    event.checkoutMethod === 'qr' ? 'scanned' : 'typed'
                  }`}
            </dd>
          </div>
        ) : null}
      </dl>

      <section className="visit-details__section" aria-labelledby="visit-details-map">
        <h3 id="visit-details-map" className="visit-details__heading">
          Location
        </h3>
        {dependant ? (
          <VisitLocationMap
            home={{ lat: dependant.geofenceLat, lng: dependant.geofenceLng }}
            homeLabel={`${dependant.fullName}'s home`}
            homeState={outcome}
            radiusMeters={dependant.geofenceRadiusMeters}
          />
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

      {/* Supervisors resolve exceptions; the section shows once the visit is one. */}
      {identity?.role === 'supervisor' && exceptionKinds.length > 0 ? (
        <VisitResolutionSection
          visitId={visit.id}
          exceptionKinds={exceptionKinds}
          resolutions={resolutions}
        />
      ) : null}
    </div>
  );
}

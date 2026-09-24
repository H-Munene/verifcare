import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../api/useApi';
import type { VerificationAttemptType } from '../api/visitSchedules';
import { Badge } from '../design-system/Badge';
import type { BadgeTone } from '../design-system/Badge';
import { Card } from '../design-system/Card';
import { Timeline, type TimelineStep } from '../design-system/Timeline';
import './VisitDetailPage.css';

// Tapping a row on VisitsPage lands here (2026-09-23, user request): the same four milestones the
// user described - check-in, each side's photo verification, checkout - read off
// GET /visit-schedules/{id}/verification's already-existing event/attempts pair (HEZ-42's own
// stated purpose, "the audit drill-down behind the admin web app's visit-history view", just never
// actually consumed by this app until now).
function firstPassingAttemptTime(
  attempts: { attemptType: VerificationAttemptType; passed: boolean; attemptedAt: string }[],
  attemptType: VerificationAttemptType,
): string | null {
  return attempts.find((a) => a.attemptType === attemptType && a.passed)?.attemptedAt ?? null;
}

function formatWindow(scheduledStart: string, scheduledEnd: string): string {
  const start = new Date(scheduledStart);
  const end = new Date(scheduledEnd);
  const dateLabel = start.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${dateLabel}, ${start.toLocaleTimeString(undefined, timeOpts)} - ${end.toLocaleTimeString(undefined, timeOpts)}`;
}

function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'missed':
    case 'investigated':
      return 'danger';
    default:
      return 'neutral';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'in_progress':
      return 'Checked In';
    case 'completed':
      return 'Checked Out';
    default:
      return status.replace('_', ' ');
  }
}

export function VisitDetailPage() {
  const { visitId } = useParams<{ visitId: string }>();
  const { visitSchedules } = useApi();
  const navigate = useNavigate();

  const visitQuery = useQuery({
    queryKey: ['visit-schedule', visitId],
    queryFn: () => visitSchedules.getVisitSchedule(visitId!),
  });
  const verificationQuery = useQuery({
    queryKey: ['visit-schedule', visitId, 'verification'],
    queryFn: () => visitSchedules.getVisitVerification(visitId!),
  });

  if (visitQuery.isLoading) {
    return <p>Loading...</p>;
  }
  if (visitQuery.isError || !visitQuery.data) {
    return <p>Failed to load this visit.</p>;
  }
  const visit = visitQuery.data;
  const event = verificationQuery.data?.event ?? null;
  const attempts = verificationQuery.data?.attempts ?? [];

  const steps: TimelineStep[] = [
    { label: 'Checked in', timestamp: event?.checkinAt ?? null },
    {
      label: 'Caregiver photo verified',
      timestamp: firstPassingAttemptTime(attempts, 'caregiver_liveness'),
    },
    {
      label: 'Dependant photo verified',
      timestamp: firstPassingAttemptTime(attempts, 'dependant_liveness'),
    },
    { label: 'Checked out', timestamp: event?.checkoutAt ?? null },
  ];

  return (
    <div className="visit-detail-page">
      <button type="button" className="visit-detail-page__back" onClick={() => void navigate(-1)}>
        ‹ Back
      </button>

      <div className="visit-detail-page__header">
        <div>
          <h1 className="visit-detail-page__title">
            {visit.caregiverDisplayName} <span className="visit-detail-page__arrow">→</span>{' '}
            {visit.dependantDisplayName}
          </h1>
          <div className="visit-detail-page__meta">
            {formatWindow(visit.scheduledStart, visit.scheduledEnd)}
          </div>
        </div>
        <Badge tone={statusTone(visit.status)}>{statusLabel(visit.status)}</Badge>
      </div>

      <Card className="visit-detail-page__timeline-card">
        <div className="visit-detail-page__section-title">Visit Timeline</div>
        {verificationQuery.isLoading ? (
          <p>Loading...</p>
        ) : (
          <Timeline steps={steps} />
        )}
      </Card>
    </div>
  );
}

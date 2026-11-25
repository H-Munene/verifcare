import {
  Calendar03Icon,
  ChartLineData01Icon,
  Mic01Icon,
  Table01Icon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../api/useApi';
import type { VoiceCheckResult } from '../api/visitSchedules';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { LoadError } from '../design-system/LoadError';
import { TableSkeleton } from '../design-system/Skeleton';
import { TableFrame, Th } from '../design-system/Table';
import { VoiceScoreTrend } from './VoiceScoreTrend';
import './VisitHistoryList.css';

// The Voice checks tab (2026-11-13), in the place the Cognitive Trend tab had: each of the
// dependant's visit recordings, checked against their enrolled voiceprint. Advisory only: a mismatch
// never changed whether the visit counted, and the check can be wrong (noise, a cold, a new phone).
// Caregivers had one too until 2026-11-24, when visits stopped recording the caregiver.

const RESULT: Record<VoiceCheckResult, { label: string; tone: 'success' | 'danger' | 'neutral' }> =
  {
    match: { label: 'Match', tone: 'success' },
    mismatch: { label: 'Mismatch', tone: 'danger' },
    too_short: { label: 'Too short', tone: 'neutral' },
    not_enrolled: { label: 'Not enrolled', tone: 'neutral' },
    no_consent: { label: 'No consent', tone: 'neutral' },
    unavailable: { label: 'Unavailable', tone: 'neutral' },
  };

export interface VoiceChecksListProps {
  dependantId: string;
}

export function VoiceChecksList({ dependantId }: VoiceChecksListProps) {
  const { visitSchedules } = useApi();
  const [showTrend, setShowTrend] = useState(false);
  const query = useQuery({
    queryKey: ['voice-checks', dependantId],
    queryFn: () => visitSchedules.listVoiceChecks(dependantId),
  });

  if (query.isLoading) {
    return <TableSkeleton columns={4} rows={4} />;
  }
  if (query.isError || !query.data) {
    return <LoadError what="the voice checks" onRetry={() => void query.refetch()} />;
  }
  const { enrolment, items } = query.data;

  const trendButton =
    items.length > 0 ? (
      <Button type="button" aria-pressed={showTrend} onClick={() => setShowTrend((on) => !on)}>
        <HugeiconsIcon
          icon={showTrend ? Table01Icon : ChartLineData01Icon}
          size={16}
          strokeWidth={1.5}
          aria-hidden
        />
        {showTrend ? 'Show list' : 'Show trend'}
      </Button>
    ) : null;

  return (
    <div>
      <div className="voice-checks__bar">
        <p className="visit-history-list__empty">
          {enrolment.enrolled && enrolment.enrolledAt
            ? `Voice recorded on ${new Date(enrolment.enrolledAt).toLocaleDateString()}.`
            : 'No voice recorded yet, so recordings are not checked.'}
        </p>
        {trendButton}
      </div>
      {items.length === 0 ? (
        <p className="visit-history-list__empty">No recordings yet.</p>
      ) : showTrend ? (
        <VoiceScoreTrend items={items} />
      ) : (
        <TableFrame>
          <table className="ds-table ds-table--table-cell">
            <thead>
              <tr>
                <Th icon={Calendar03Icon}>Visit</Th>
                <Th icon={UserIcon}>Caregiver</Th>
                <Th icon={Mic01Icon}>Result</Th>
                <Th>Score</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const result = item.result ? RESULT[item.result] : null;
                return (
                  <tr key={item.visitScheduleId}>
                    <td>
                      {new Date(item.scheduledStart).toLocaleString(undefined, {
                        day: 'numeric',
                        month: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </td>
                    <td>{item.caregiverName}</td>
                    <td>
                      {result ? <Badge tone={result.tone}>{result.label}</Badge> : 'Not checked'}
                    </td>
                    <td>{item.score != null ? item.score.toFixed(2) : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableFrame>
      )}
    </div>
  );
}

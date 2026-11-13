import {
  Calendar03Icon,
  CheckmarkBadge01Icon,
  HandHeartIcon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { TableFrame, Th } from '../design-system/Table';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api/useApi';
import type { VisitSchedule } from '../api/visitSchedules';
import { Badge } from '../design-system/Badge';
import './VisitHistoryList.css';
import { TableSkeleton } from '../design-system/Skeleton';
import { statusLabel, statusTone } from './visitStatus';
import { VisitPanel } from './VisitPanel';
import { LoadError } from '../design-system/LoadError';

// Shared by DependantDetailPage's and CaregiverDetailPage's own Visit History tab (2026-09-23,
// user request) - GET /visit-schedules already supports filtering by exactly one of
// caregiverId/dependantId, so this is a thin, read-only reuse of the same list endpoint
// VisitsPage's own table uses, not a new backend capability.

function formatWindow(scheduledStart: string, scheduledEnd: string): string {
  const start = new Date(scheduledStart);
  const end = new Date(scheduledEnd);
  const dateLabel = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${dateLabel}, ${start.toLocaleTimeString(undefined, timeOpts)} - ${end.toLocaleTimeString(undefined, timeOpts)}`;
}

export interface VisitHistoryListProps {
  caregiverId?: string;
  dependantId?: string;
}

export function VisitHistoryList({ caregiverId, dependantId }: VisitHistoryListProps) {
  const { visitSchedules } = useApi();
  const [open, setOpen] = useState<VisitSchedule | null>(null);

  const query = useQuery({
    queryKey: ['visit-schedules', 'for-subject', caregiverId ?? dependantId],
    queryFn: () => visitSchedules.listVisitSchedules({ caregiverId, dependantId, limit: 20 }),
  });

  if (query.isLoading) {
    return <TableSkeleton columns={4} rows={4} />;
  }
  if (query.isError) {
    return <LoadError what="the visit history" onRetry={() => void query.refetch()} />;
  }

  const rows = [...(query.data?.items ?? [])].sort(
    (a, b) => new Date(b.scheduledStart).getTime() - new Date(a.scheduledStart).getTime(),
  );

  if (rows.length === 0) {
    return <p className="visit-history-list__empty">No visits yet.</p>;
  }

  return (
    <TableFrame>
      <table className="ds-table ds-table--table-cell">
        <thead>
          <tr>
            <Th icon={UserIcon}>Caregiver</Th>
            <Th icon={HandHeartIcon}>Dependant</Th>
            <Th icon={Calendar03Icon}>Scheduled window</Th>
            <Th icon={CheckmarkBadge01Icon}>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((visit) => (
            <tr key={visit.id} className="ds-table__row--link" onClick={() => setOpen(visit)}>
              <td>
                {/* A real link for new tabs; a plain click opens the panel here (user request). */}
                <Link
                  to={`/visits?visit=${visit.id}`}
                  className="ds-table__link"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!event.metaKey && !event.ctrlKey && !event.shiftKey) {
                      event.preventDefault();
                      setOpen(visit);
                    }
                  }}
                >
                  {visit.caregiverDisplayName}
                </Link>
              </td>
              <td>{visit.dependantDisplayName}</td>
              <td>{formatWindow(visit.scheduledStart, visit.scheduledEnd)}</td>
              <td>
                <Badge tone={statusTone(visit.status)}>{statusLabel(visit.status)}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open ? <VisitPanel visitId={open.id} visit={open} onClose={() => setOpen(null)} /> : null}
    </TableFrame>
  );
}

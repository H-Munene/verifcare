import {
  Calendar03Icon,
  CheckmarkBadge01Icon,
  HandHeartIcon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { TableFrame, Th } from '../design-system/Table';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../api/useApi';
import { Badge } from '../design-system/Badge';
import './VisitHistoryList.css';
import { TableSkeleton } from '../design-system/Skeleton';
import { statusLabel, statusTone } from './visitStatus';

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
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ['visit-schedules', 'for-subject', caregiverId ?? dependantId],
    queryFn: () => visitSchedules.listVisitSchedules({ caregiverId, dependantId, limit: 20 }),
  });

  if (query.isLoading) {
    return <TableSkeleton columns={4} rows={4} />;
  }
  if (query.isError) {
    return <p>Failed to load visit history.</p>;
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
            <tr
              key={visit.id}
              className="ds-table__row--link"
              onClick={() => void navigate(`/visits/${visit.id}`)}
            >
              <td>
                <Link
                  to={`/visits/${visit.id}`}
                  className="ds-table__link"
                  onClick={(event) => event.stopPropagation()}
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
    </TableFrame>
  );
}

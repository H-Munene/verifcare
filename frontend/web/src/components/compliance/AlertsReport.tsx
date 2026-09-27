// Alert response: how quickly missed-visit alerts raised this month were acknowledged, overall and
// by supervisor. Alerts are shared by every supervisor, so whoever acknowledged one answered it.

import { UserIcon } from '@hugeicons/core-free-icons';
import { useQuery } from '@tanstack/react-query';
import type { Period } from '../../api/compliance';
import { useApi } from '../../api/useApi';
import { SkeletonRegion, Skeleton, TableSkeleton } from '../../design-system/Skeleton';
import { StatTiles } from '../../design-system/StatTiles';
import { TableFrame, Th } from '../../design-system/Table';
import { dateTime, minutes } from './format';

export function AlertsReport({ period }: { period: Period }) {
  const { compliance } = useApi();
  const query = useQuery({
    queryKey: ['compliance', 'alerts', period],
    queryFn: () => compliance.getAlertResponse(period),
  });
  const report = query.data;

  if (query.isError) {
    return <p className="compliance__message">The report couldn't be loaded.</p>;
  }
  if (!report) {
    return (
      <>
        <SkeletonRegion label="Loading alert response" className="compliance__tiles-skeleton">
          <Skeleton height={96} radius={0} />
        </SkeletonRegion>
        <TableSkeleton columns={3} rows={3} />
      </>
    );
  }

  return (
    <>
      <StatTiles
        label="Missed-visit alerts this month"
        tiles={[
          { label: 'Alerts raised', value: report.raised, detail: 'One per missed visit' },
          {
            label: 'Acknowledged',
            value: report.acknowledged,
            detail:
              report.unacknowledged > 0 && report.oldestUnacknowledgedSentAt
                ? `${report.unacknowledged} waiting since ${dateTime(report.oldestUnacknowledgedSentAt)}`
                : report.raised > 0
                  ? 'None waiting'
                  : 'No alerts this month',
          },
          {
            label: 'Median time to acknowledge',
            value: minutes(report.medianMinutesToAcknowledge),
            detail: 'Half were answered faster',
          },
          {
            label: '90% answered within',
            value: minutes(report.p90MinutesToAcknowledge),
            detail: 'The slowest tenth took longer',
          },
        ]}
      />

      <TableFrame>
        <table className="ds-table ds-table--table-cell">
          <thead>
            <tr>
              <Th icon={UserIcon}>Supervisor</Th>
              <Th className="compliance__num">Alerts acknowledged</Th>
              <Th className="compliance__num">Median time to acknowledge</Th>
            </tr>
          </thead>
          <tbody>
            {report.bySupervisor.map((row) => (
              <tr key={row.userId}>
                <td>{row.name}</td>
                <td className="compliance__num">{row.acknowledged}</td>
                <td className="compliance__num">{minutes(row.medianMinutesToAcknowledge)}</td>
              </tr>
            ))}
            {report.bySupervisor.length === 0 ? (
              <tr>
                <td colSpan={3} className="ds-table__empty">
                  {report.raised > 0
                    ? 'No alert has been acknowledged yet this month.'
                    : 'No visits were missed this month, so no alerts were raised.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </TableFrame>
    </>
  );
}

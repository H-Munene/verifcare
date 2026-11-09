// Caregiver performance: how each caregiver's visits went this month. Separate measures with no
// overall score, because a single number would hide why, and this may inform decisions about a
// person's job. Misses a supervisor has accounted for as outside the caregiver's control are shown
// as excused and not counted against them.

import { Alert02Icon, Clock01Icon, UserIcon } from '@hugeicons/core-free-icons';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { CaregiverPerformanceRow, Period } from '../../api/compliance';
import { useApi } from '../../api/useApi';
import { SidePanel } from '../../design-system/SidePanel';
import { TableSkeleton } from '../../design-system/Skeleton';
import { TableFrame, Th } from '../../design-system/Table';
import { date, percent } from './format';
import { Flag } from './Marks';

const SKIP_LABELS: Record<keyof CaregiverPerformanceRow['recordingsSkipped'], string> = {
  dependant_declined: 'Dependant preferred not to be recorded',
  dependant_unwell_or_asleep: 'Dependant unwell or asleep',
  technical_problem: 'Technical problem',
  other: 'Other reason',
};

const wholeMinutes = (value: number | null) => (value === null ? '-' : `${Math.round(value)} min`);

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="compliance__fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function CaregiverDetail({ row, onClose }: { row: CaregiverPerformanceRow; onClose: () => void }) {
  const skipped = Object.entries(row.recordingsSkipped).filter(([, count]) => count > 0) as [
    keyof CaregiverPerformanceRow['recordingsSkipped'],
    number,
  ][];
  return (
    <SidePanel title={row.caregiverName} eyebrow="Caregiver performance" onClose={onClose}>
      <dl className="compliance__facts">
        <Fact label="Visits assigned" value={row.assigned} />
        <Fact label="Completed" value={row.completed} />
        <Fact label="Missed" value={row.missed} />
        <Fact label="Excused" value={row.excused} />
        <Fact label="Average check-in delay" value={wholeMinutes(row.averageCheckinDelayMinutes)} />
        <Fact label="Average visit length" value={wholeMinutes(row.averageVisitMinutes)} />
        <Fact label="Planned visit length" value={wholeMinutes(row.averagePlannedMinutes)} />
        <Fact label="Required tasks done" value={percent(row.requiredTasksDoneRate)} />
        <Fact label="Confirmed by family code" value={percent(row.qrVerifiedRate)} />
        <Fact label="Supervisor overrides" value={row.supervisorOverrides} />
        <Fact label="Failed check-in attempts" value={row.failedCheckins} />
        <Fact label="Recordings provided" value={row.recordingsProvided} />
        <Fact label="Cover offers received" value={row.offersReceived} />
        <Fact label="Accepted" value={row.offersAccepted} />
        <Fact label="Declined" value={row.offersDeclined} />
        <Fact label="Expired unanswered" value={row.offersExpired} />
        <Fact label="Average response" value={wholeMinutes(row.averageOfferResponseMinutes)} />
        <Fact label="Visits covered for others" value={row.visitsCovered} />
      </dl>

      {skipped.length > 0 ? (
        <>
          <h3 className="compliance__panel-heading">Why recordings were skipped</h3>
          <ul className="compliance__panel-list">
            {skipped.map(([reason, count]) => (
              <li key={reason}>
                {SKIP_LABELS[reason]}: {count}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3 className="compliance__panel-heading">By week</h3>
      <TableFrame>
        <table className="ds-table ds-table--table-cell">
          <thead>
            <tr>
              <Th>Week of</Th>
              <Th className="compliance__num">Completed</Th>
              <Th className="compliance__num">Missed</Th>
              <Th className="compliance__num">On time</Th>
            </tr>
          </thead>
          <tbody>
            {row.weeks.map((week) => (
              <tr key={week.weekStart}>
                <td>{date(`${week.weekStart}T12:00:00Z`)}</td>
                <td className="compliance__num">{week.completed}</td>
                <td className="compliance__num">{week.missed}</td>
                <td className="compliance__num">
                  {week.checkedIn === 0 ? '-' : percent(week.onTime / week.checkedIn)}
                </td>
              </tr>
            ))}
            {row.weeks.length === 0 ? (
              <tr>
                <td colSpan={4} className="ds-table__empty">
                  No visits this month.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </TableFrame>
    </SidePanel>
  );
}

export function CaregiverPerformanceReport({ period }: { period: Period }) {
  const { compliance } = useApi();
  const [openId, setOpenId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['compliance', 'caregiver-performance', period],
    queryFn: () => compliance.getCaregiverPerformance(period),
  });
  const open = query.data?.items.find((row) => row.caregiverId === openId);

  return (
    <>
      <p className="compliance__hint">
        Misses a supervisor has resolved as outside the caregiver&rsquo;s control are shown as
        excused and aren&rsquo;t counted against them. Open a caregiver for the full picture.
      </p>
      {query.isLoading ? <TableSkeleton columns={8} /> : null}
      {query.isError ? <p className="compliance__message">The report couldn't be loaded.</p> : null}
      {query.data ? (
        <TableFrame>
          <table className="ds-table ds-table--table-cell">
            <thead>
              <tr>
                <Th icon={UserIcon}>Caregiver</Th>
                <Th className="compliance__num">Visits</Th>
                <Th className="compliance__num">Completed</Th>
                <Th className="compliance__num">Missed</Th>
                <Th className="compliance__num">Excused</Th>
                <Th className="compliance__num">Completion</Th>
                <Th className="compliance__num">On time</Th>
                <Th className="compliance__num">Covered</Th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((row) => (
                <tr key={row.caregiverId}>
                  <td>
                    <button
                      type="button"
                      className="compliance__row-button"
                      onClick={() => setOpenId(row.caregiverId)}
                    >
                      {row.caregiverName}
                    </button>
                  </td>
                  <td className="compliance__num">{row.assigned}</td>
                  <td className="compliance__num">{row.completed}</td>
                  <td className="compliance__num">
                    <Flag count={row.missed} icon={Alert02Icon} label="missed" />
                  </td>
                  <td className="compliance__num">{row.excused}</td>
                  <td className="compliance__num">{percent(row.completionRate)}</td>
                  <td className="compliance__num">
                    {row.onTimeRate !== null && row.onTimeRate < 1 ? (
                      <Flag
                        count={row.checkedIn - Math.round(row.onTimeRate * row.checkedIn)}
                        icon={Clock01Icon}
                        label="late"
                      />
                    ) : (
                      percent(row.onTimeRate)
                    )}
                  </td>
                  <td className="compliance__num">{row.visitsCovered}</td>
                </tr>
              ))}
              {query.data.items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="ds-table__empty">
                    No caregiver activity this month.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </TableFrame>
      ) : null}
      {open ? <CaregiverDetail row={open} onClose={() => setOpenId(null)} /> : null}
    </>
  );
}

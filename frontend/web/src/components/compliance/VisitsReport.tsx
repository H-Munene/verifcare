// Visit verification: the month's visits per caregiver or dependant - were they delivered, on
// time, and fully verified (family code scanned at check-in, inside the home at check-out).

import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Shield01Icon,
  Task01Icon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  SUMMARY_SORT_KEYS,
  type Period,
  type SummaryGroupBy,
  type SummarySort,
  type SummarySortKey,
} from '../../api/compliance';
import { useApi } from '../../api/useApi';
import { SegmentedControl } from '../../design-system/SegmentedControl';
import { TableSkeleton } from '../../design-system/Skeleton';
import { sortState } from '../../design-system/sortState';
import { StatTiles } from '../../design-system/StatTiles';
import { SortableTh, TableFrame, Th } from '../../design-system/Table';
import { useListParams } from '../../hooks/useListParams';
import { percent } from './format';
import { Flag, StateMark } from './Marks';

const SORTS: readonly SummarySort[] = SUMMARY_SORT_KEYS.flatMap((key) => [key, `-${key}` as const]);

export function VisitsReport({ period }: { period: Period }) {
  const { compliance } = useApi();
  const params = useListParams();
  const groupBy = params.oneOf<SummaryGroupBy>('groupBy', ['caregiver', 'dependant'], 'caregiver');
  const sort = params.oneOf('sort', SORTS, 'name');
  const { directionOf, toggled } = sortState<SummarySortKey>(sort);

  const query = useQuery({
    queryKey: ['compliance', 'visits', { ...period, groupBy, sort }],
    queryFn: () => compliance.getVisitSummary({ ...period, groupBy, sort }),
  });
  const totals = query.data?.totals;
  const personLabel = groupBy === 'caregiver' ? 'Caregiver' : 'Dependant';

  const sortable = (key: SummarySortKey, label: string, icon?: typeof UserIcon) => (
    <SortableTh
      icon={icon}
      direction={directionOf(key)}
      onSort={() => params.set('sort', toggled(key))}
      className={key === 'name' ? undefined : 'compliance__num'}
    >
      {label}
    </SortableTh>
  );

  return (
    <>
      {totals ? (
        <StatTiles
          label="The month's visits"
          tiles={[
            {
              label: 'Visits',
              value: totals.total,
              detail: `${totals.completed} completed, ${totals.cancelled} cancelled`,
            },
            {
              label: 'Completion rate',
              value: percent(totals.completionRate),
              detail: `${totals.missed} missed${totals.investigated ? `, ${totals.investigated} investigated` : ''}`,
            },
            {
              label: 'Fully verified',
              value: percent(totals.verifiedRate),
              detail: `${totals.fullyVerified} of ${totals.completed} completed visits`,
            },
            {
              label: 'Late check-ins',
              value: totals.late,
              detail: 'More than 15 minutes after the start',
            },
            {
              label: 'Missing checkouts',
              value: totals.missingCheckout,
              detail: `${totals.requiredTasksNotDone} required ${
                totals.requiredTasksNotDone === 1 ? 'task' : 'tasks'
              } not done`,
            },
          ]}
        />
      ) : null}

      <div className="compliance__subbar">
        <SegmentedControl
          label="Group visits by"
          idPrefix="compliance-visits-group"
          segments={[
            { id: 'caregiver', label: 'Caregivers' },
            { id: 'dependant', label: 'Dependants' },
          ]}
          selected={groupBy}
          onChange={(id) => params.set('groupBy', id === 'caregiver' ? '' : id)}
        />
      </div>

      {query.isLoading ? <TableSkeleton columns={9} /> : null}
      {query.isError ? <p className="compliance__message">The report couldn't be loaded.</p> : null}
      {query.data ? (
        <TableFrame>
          <table className="ds-table ds-table--table-cell">
            <thead>
              <tr>
                {sortable('name', personLabel, UserIcon)}
                {sortable('total', 'Visits')}
                <Th className="compliance__num">Completed</Th>
                {sortable('missed', 'Missed')}
                {sortable('completionRate', 'Completion')}
                {sortable('verifiedRate', 'Verified')}
                {sortable('late', 'Late')}
                {sortable('missingCheckout', 'No checkout')}
                <Th className="compliance__num">Tasks not done</Th>
              </tr>
            </thead>
            <tbody>
              {query.data.rows.map((row) => (
                <tr key={row.personId}>
                  <td>
                    <Link
                      className="ds-table__link"
                      to={`/${groupBy === 'caregiver' ? 'caregivers' : 'dependants'}/${row.personId}`}
                    >
                      {row.personName}
                    </Link>
                  </td>
                  <td className="compliance__num">{row.total}</td>
                  <td className="compliance__num">{row.completed}</td>
                  <td className="compliance__num">
                    <Flag count={row.missed} icon={Alert02Icon} label="missed" />
                  </td>
                  <td className="compliance__num">{percent(row.completionRate)}</td>
                  <td className="compliance__num">
                    {row.verifiedRate === 1 ? (
                      <StateMark icon={CheckmarkCircle02Icon} tone="ok">
                        100%
                      </StateMark>
                    ) : (
                      percent(row.verifiedRate)
                    )}
                  </td>
                  <td className="compliance__num">
                    <Flag count={row.late} icon={Clock01Icon} label="late" />
                  </td>
                  <td className="compliance__num">
                    <Flag
                      count={row.missingCheckout}
                      icon={Shield01Icon}
                      label="without checkout"
                    />
                  </td>
                  <td className="compliance__num">
                    <Flag
                      count={row.requiredTasksNotDone}
                      icon={Task01Icon}
                      label="tasks not done"
                    />
                  </td>
                </tr>
              ))}
              {query.data.rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="ds-table__empty">
                    No visits were scheduled this month.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </TableFrame>
      ) : null}
    </>
  );
}

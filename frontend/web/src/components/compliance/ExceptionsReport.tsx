// Exceptions: the month's missed visits, visits never checked out, visits with a failed check, and
// visits a supervisor started because no family member could show a code, each with how it was resolved. A row opens the visit's side panel, where it is resolved.

import {
  Alert02Icon,
  Calendar03Icon,
  CheckmarkCircle02Icon,
  FilterIcon,
  HelpCircleIcon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { useQuery } from '@tanstack/react-query';
import { RESOLUTION_OUTCOME_LABELS, type ExceptionKind, type Period } from '../../api/compliance';
import { useApi } from '../../api/useApi';
import { Button } from '../../design-system/Button';
import { FilterBar, FilterMenu } from '../../design-system/FilterMenu';
import { TableSkeleton } from '../../design-system/Skeleton';
import { TableFrame, Th } from '../../design-system/Table';
import { useCursorPages } from '../../hooks/useCursorPages';
import { useListParams } from '../../hooks/useListParams';
import { VisitPanel } from '../VisitPanel';
import { dateTime, EXCEPTION_KIND_LABELS, failedCheckLabel } from './format';
import { StateMark } from './Marks';

const KINDS: readonly ExceptionKind[] = [
  'missed',
  'missing_checkout',
  'failed_check',
  'supervisor_override',
  'checkout_override',
];

export function ExceptionsReport({ period }: { period: Period }) {
  const { compliance } = useApi();
  const params = useListParams();
  const kind = params.oneOf<ExceptionKind | ''>('kind', ['', ...KINDS], '');
  const resolved = params.oneOf('resolved', ['', 'true', 'false'] as const, '');
  const pages = useCursorPages(`${period.from}|${kind}|${resolved}`);
  const openVisitId = params.get('visit');

  const query = useQuery({
    queryKey: ['compliance', 'exceptions', { ...period, kind, resolved, cursor: pages.cursor }],
    queryFn: () =>
      compliance.listExceptions({
        ...period,
        kind: kind || undefined,
        resolved: resolved ? resolved === 'true' : undefined,
        cursor: pages.cursor,
        limit: 20,
      }),
  });
  const filtered = Boolean(kind || resolved);

  return (
    <>
      <FilterBar onClear={filtered ? () => params.clear(['kind', 'resolved']) : undefined}>
        <FilterMenu
          label="Issue"
          icon={FilterIcon}
          value={kind}
          allLabel="All issues"
          options={KINDS.map((k) => ({ value: k, label: EXCEPTION_KIND_LABELS[k] }))}
          onChange={(value) => params.set('kind', value)}
        />
        <FilterMenu
          label="Resolution"
          icon={CheckmarkCircle02Icon}
          value={resolved}
          allLabel="Resolved or not"
          options={[
            { value: 'false', label: 'Unresolved' },
            { value: 'true', label: 'Resolved' },
          ]}
          onChange={(value) => params.set('resolved', value)}
        />
      </FilterBar>

      {query.data ? (
        <p className="compliance__count">
          {query.data.total} {query.data.total === 1 ? 'exception' : 'exceptions'}
          {filtered ? ' match these filters' : ' this month'}
        </p>
      ) : null}

      {query.isLoading ? <TableSkeleton columns={5} /> : null}
      {query.isError ? <p className="compliance__message">The report couldn't be loaded.</p> : null}
      {query.data ? (
        <>
          <TableFrame>
            <table className="ds-table ds-table--table-cell">
              <thead>
                <tr>
                  <Th icon={Calendar03Icon}>Scheduled</Th>
                  <Th icon={UserIcon}>Visit</Th>
                  <Th icon={Alert02Icon}>Issue</Th>
                  <Th>Details</Th>
                  <Th icon={CheckmarkCircle02Icon}>Resolution</Th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((item) => (
                  <tr
                    key={item.visitScheduleId}
                    className="ds-table__row--link"
                    onClick={() => params.set('visit', item.visitScheduleId)}
                  >
                    <td className="compliance__nowrap">
                      <button
                        type="button"
                        className="ds-table__link compliance__row-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          params.set('visit', item.visitScheduleId);
                        }}
                      >
                        {dateTime(item.scheduledStart)}
                      </button>
                    </td>
                    <td>
                      {item.caregiverName} <span className="compliance__arrow">→</span>{' '}
                      {item.dependantName}
                    </td>
                    <td>
                      <span className="compliance__kinds">
                        {item.kinds.map((k) => (
                          <span key={k} className="compliance__kind">
                            {EXCEPTION_KIND_LABELS[k]}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="compliance__details">
                      {item.failedChecks.length > 0
                        ? item.failedChecks.map(failedCheckLabel).join('; ')
                        : item.kinds.includes('missing_checkout') && item.checkinAt
                          ? `Checked in ${dateTime(item.checkinAt)}`
                          : 'No check-in'}
                    </td>
                    <td>
                      {item.latestResolution ? (
                        <span className="compliance__resolution">
                          <StateMark icon={CheckmarkCircle02Icon} tone="ok">
                            {RESOLUTION_OUTCOME_LABELS[item.latestResolution.outcome]}
                          </StateMark>
                          <span className="compliance__by">
                            {item.latestResolution.resolvedByName}
                          </span>
                        </span>
                      ) : (
                        <StateMark icon={HelpCircleIcon} tone="problem">
                          Unresolved
                        </StateMark>
                      )}
                    </td>
                  </tr>
                ))}
                {query.data.items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="ds-table__empty">
                      {filtered
                        ? 'No exceptions match these filters.'
                        : 'No exceptions this month: every visit was delivered and verified.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableFrame>

          {pages.canGoBack || query.data.nextCursor ? (
            <div className="compliance__pagination">
              <Button disabled={!pages.canGoBack} onClick={pages.back}>
                Previous
              </Button>
              <Button
                disabled={!query.data.nextCursor}
                onClick={() => {
                  if (query.data.nextCursor) {
                    pages.next(query.data.nextCursor);
                  }
                }}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {openVisitId ? (
        <VisitPanel visitId={openVisitId} onClose={() => params.set('visit', '')} />
      ) : null}
    </>
  );
}

// Audit log: who did what to which record, and when - every change, every compliance export, and
// views of check-in details and listens to visit recordings - newest first. The trail is append-only.

import {
  Calendar03Icon,
  File01Icon,
  FilterIcon,
  Task01Icon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import type { AuditLogEntry, Period } from '../../api/compliance';
import { useApi } from '../../api/useApi';
import { Button } from '../../design-system/Button';
import { FilterBar, FilterMenu } from '../../design-system/FilterMenu';
import { TableSkeleton } from '../../design-system/Skeleton';
import { TableFrame, Th } from '../../design-system/Table';
import { useCursorPages } from '../../hooks/useCursorPages';
import { useListParams } from '../../hooks/useListParams';
import { VisitPanel } from '../VisitPanel';
import { dateTime, humanise } from './format';

function isChange(value: unknown): value is { from: unknown; to: unknown } {
  return typeof value === 'object' && value !== null && 'from' in value && 'to' in value;
}

function show(value: unknown): string {
  if (value === null || value === undefined) {
    return 'none';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** One line for the table: "status: missed → investigated; phoneNumber changed; report: visits". */
function summary(metadata: AuditLogEntry['metadata']): string {
  if (!metadata) {
    return '';
  }
  return Object.entries(metadata)
    .map(([key, value]) =>
      isChange(value)
        ? `${key}: ${show(value.from)} → ${show(value.to)}`
        : value === 'changed'
          ? `${key} changed`
          : `${key}: ${show(value)}`,
    )
    .join('; ');
}

export function AuditLogReport({ period }: { period: Period }) {
  const { compliance } = useApi();
  const params = useListParams();
  const action = params.get('action');
  const entityType = params.get('entityType');
  const pages = useCursorPages(`${period.from}|${action}|${entityType}`);
  const [expanded, setExpanded] = useState<string | null>(null);
  const openVisitId = params.get('visit');

  const facets = useQuery({
    queryKey: ['compliance', 'audit-log', 'facets'],
    queryFn: () => compliance.getAuditLogFacets(),
  });
  const query = useQuery({
    queryKey: ['compliance', 'audit-log', { ...period, action, entityType, cursor: pages.cursor }],
    queryFn: () =>
      compliance.listAuditLog({
        ...period,
        action: action || undefined,
        entityType: entityType || undefined,
        cursor: pages.cursor,
        limit: 25,
      }),
  });
  const filtered = Boolean(action || entityType);

  return (
    <>
      <FilterBar onClear={filtered ? () => params.clear(['action', 'entityType']) : undefined}>
        <FilterMenu
          label="Action"
          icon={FilterIcon}
          value={action}
          allLabel="All actions"
          options={(facets.data?.actions ?? []).map((a) => ({ value: a, label: humanise(a) }))}
          onChange={(value) => params.set('action', value)}
          searchPlaceholder="Search actions"
        />
        <FilterMenu
          label="Record"
          icon={File01Icon}
          value={entityType}
          allLabel="All records"
          options={(facets.data?.entityTypes ?? []).map((t) => ({ value: t, label: humanise(t) }))}
          onChange={(value) => params.set('entityType', value)}
        />
      </FilterBar>

      {query.isLoading ? <TableSkeleton columns={5} /> : null}
      {query.isError ? (
        <p className="compliance__message">The audit log couldn't be loaded.</p>
      ) : null}
      {query.data ? (
        <>
          <TableFrame>
            <table className="ds-table ds-table--table-cell">
              <thead>
                <tr>
                  <Th icon={Calendar03Icon}>Time</Th>
                  <Th icon={UserIcon}>Who</Th>
                  <Th icon={Task01Icon}>Action</Th>
                  <Th icon={File01Icon}>Record</Th>
                  <Th>Details</Th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((entry) => {
                  const details = summary(entry.metadata);
                  const isOpen = expanded === entry.id;
                  return (
                    <Fragment key={entry.id}>
                      <tr>
                        <td className="compliance__nowrap">{dateTime(entry.createdAt)}</td>
                        <td>
                          {entry.actorName ?? (entry.actorUserId ? 'Unknown user' : 'System')}
                          {entry.actorRole ? (
                            <span className="compliance__by"> {humanise(entry.actorRole)}</span>
                          ) : null}
                        </td>
                        <td>{humanise(entry.action)}</td>
                        <td>
                          {entry.entityType === 'visit_schedule' && entry.entityId ? (
                            <button
                              type="button"
                              className="ds-table__link compliance__row-button"
                              onClick={() => params.set('visit', entry.entityId ?? '')}
                            >
                              Visit
                            </button>
                          ) : (
                            humanise(entry.entityType)
                          )}
                        </td>
                        <td className="compliance__details">
                          {details ? (
                            <button
                              type="button"
                              className="compliance__expand"
                              aria-expanded={isOpen}
                              onClick={() => setExpanded(isOpen ? null : entry.id)}
                              title={isOpen ? 'Hide the full record' : 'Show the full record'}
                            >
                              {details}
                            </button>
                          ) : (
                            <span className="compliance__zero">-</span>
                          )}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className="compliance__expanded">
                          <td colSpan={5}>
                            <pre>{JSON.stringify(entry.metadata, null, 2)}</pre>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
                {query.data.items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="ds-table__empty">
                      {filtered
                        ? 'Nothing matches these filters this month.'
                        : 'Nothing was recorded this month.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableFrame>

          {pages.canGoBack || query.data.nextCursor ? (
            <div className="compliance__pagination">
              <Button disabled={!pages.canGoBack} onClick={pages.back}>
                Newer
              </Button>
              <Button
                disabled={!query.data.nextCursor}
                onClick={() => {
                  if (query.data.nextCursor) {
                    pages.next(query.data.nextCursor);
                  }
                }}
              >
                Older
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

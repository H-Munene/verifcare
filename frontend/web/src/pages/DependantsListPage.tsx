import {
  Calendar03Icon,
  CheckmarkBadge01Icon,
  UserIcon,
  UserSquareIcon,
} from '@hugeicons/core-free-icons';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { DependantStatus, ListDependantsParams } from '../api/dependants';
import { useApi } from '../api/useApi';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { FilterBar, FilterMenu } from '../design-system/FilterMenu';
import { sortState } from '../design-system/sortState';
import { SortableTh, TableFrame, Th } from '../design-system/Table';
import { useCursorPages } from '../hooks/useCursorPages';
import { useListParams } from '../hooks/useListParams';
import './DependantsListPage.css';
import { TableSkeleton } from '../design-system/Skeleton';
import { LoadError } from '../design-system/LoadError';

type DependantSort = NonNullable<ListDependantsParams['sort']>;

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'deactivated', label: 'Deactivated' },
];

const SORTS: readonly DependantSort[] = ['name', '-name', 'dob', '-dob'];

// Filters and sort live in the URL (2026-09-26, the new table filters), so a reload or a shared
// link keeps them, and the server applies them, so they cover the whole list, not just a page.
export function DependantsListPage() {
  const { dependants } = useApi();
  const navigate = useNavigate();
  const params = useListParams();
  const status = params.get('status') as DependantStatus | '';
  const sort = params.oneOf('sort', SORTS, 'name');
  const pages = useCursorPages(`${status}|${sort}`);
  const { directionOf, toggled } = sortState<'name' | 'dob'>(sort);

  const query = useQuery({
    queryKey: ['dependants', { status, sort, cursor: pages.cursor }],
    queryFn: () =>
      dependants.listDependants({
        status: status || undefined,
        sort,
        cursor: pages.cursor,
        limit: 20,
      }),
  });
  const filtered = Boolean(status);

  return (
    <div>
      <div className="dependants-page__toolbar">
        <div className="dependants-page__toolbar-actions">
          <Button
            variant="cta-pill"
            onClick={() => {
              void navigate('/dependants/new');
            }}
          >
            + Register Dependant
          </Button>
        </div>
      </div>

      <FilterBar onClear={filtered ? () => params.clear(['status']) : undefined}>
        <FilterMenu
          label="Status"
          icon={CheckmarkBadge01Icon}
          value={status}
          allLabel="All statuses"
          options={STATUS_OPTIONS}
          onChange={(value) => params.set('status', value)}
        />
      </FilterBar>

      {query.isLoading ? <TableSkeleton columns={5} /> : null}
      {query.isError ? (
        <LoadError what="the dependants" onRetry={() => void query.refetch()} />
      ) : null}

      {query.data ? (
        <>
          <TableFrame>
            <table className="ds-table ds-table--table-cell">
              <thead>
                <tr>
                  <SortableTh
                    icon={UserIcon}
                    direction={directionOf('name')}
                    onSort={() => params.set('sort', toggled('name'))}
                  >
                    Name
                  </SortableTh>
                  <SortableTh
                    icon={Calendar03Icon}
                    direction={directionOf('dob')}
                    onSort={() => params.set('sort', toggled('dob'))}
                  >
                    Date of birth
                  </SortableTh>
                  <Th icon={UserSquareIcon}>Gender</Th>
                  <Th icon={CheckmarkBadge01Icon}>Status</Th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((dependant) => (
                  <tr
                    key={dependant.id}
                    className="ds-table__row--link"
                    onClick={() => {
                      void navigate(`/dependants/${dependant.id}`);
                    }}
                  >
                    <td>
                      <Link
                        to={`/dependants/${dependant.id}`}
                        className="ds-table__link"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {dependant.fullName}
                      </Link>
                    </td>
                    <td>{dependant.dob}</td>
                    <td>{dependant.gender ?? '-'}</td>
                    <td>
                      <Badge tone={dependant.status === 'active' ? 'success' : 'neutral'}>
                        {dependant.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
                {query.data.items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="ds-table__empty">
                      {filtered
                        ? 'No dependants match these filters.'
                        : 'No dependants registered yet.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableFrame>

          <div className="dependants-page__pagination">
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
        </>
      ) : null}
    </div>
  );
}

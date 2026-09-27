import { Calendar03Icon, CheckmarkBadge01Icon, IdIcon, UserIcon } from '@hugeicons/core-free-icons';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { ListCaregiversParams } from '../api/caregivers';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { FilterBar, FilterMenu } from '../design-system/FilterMenu';
import { sortState } from '../design-system/sortState';
import { SortableTh, TableFrame, Th } from '../design-system/Table';
import { useCursorPages } from '../hooks/useCursorPages';
import { useListParams } from '../hooks/useListParams';
import './CaregiversListPage.css';
import { TableSkeleton } from '../design-system/Skeleton';

type CaregiverSort = NonNullable<ListCaregiversParams['sort']>;

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

const SORTS: readonly CaregiverSort[] = ['name', '-name', 'hireDate', '-hireDate'];

// Filters and sort live in the URL and are applied by the server - see DependantsListPage.tsx.
export function CaregiversListPage() {
  const { caregivers } = useApi();
  const { identity } = useAuth();
  const navigate = useNavigate();
  const params = useListParams();
  const status = params.oneOf('status', ['', 'active', 'inactive'] as const, '');
  const sort = params.oneOf('sort', SORTS, 'name');
  const pages = useCursorPages(`${status}|${sort}`);
  const { directionOf, toggled } = sortState<'name' | 'hireDate'>(sort);

  const query = useQuery({
    queryKey: ['caregivers', { status, sort, cursor: pages.cursor }],
    queryFn: () =>
      caregivers.listCaregivers({
        active: status ? status === 'active' : undefined,
        sort,
        cursor: pages.cursor,
        limit: 20,
      }),
  });

  return (
    <div>
      <div className="caregivers-page__toolbar">
        <h1 className="caregivers-page__title">Caregivers</h1>
        {identity?.role === 'supervisor' ? (
          <Button
            variant="cta-pill"
            onClick={() => {
              void navigate('/caregivers/new');
            }}
          >
            + Register Caregiver
          </Button>
        ) : null}
      </div>

      <FilterBar onClear={status ? () => params.clear(['status']) : undefined}>
        <FilterMenu
          label="Status"
          icon={CheckmarkBadge01Icon}
          value={status}
          allLabel="All statuses"
          options={STATUS_OPTIONS}
          onChange={(value) => params.set('status', value)}
        />
      </FilterBar>

      {query.isLoading ? <TableSkeleton columns={4} /> : null}
      {query.isError ? <p>Failed to load caregivers.</p> : null}

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
                  <Th icon={IdIcon}>Employee #</Th>
                  <SortableTh
                    icon={Calendar03Icon}
                    direction={directionOf('hireDate')}
                    onSort={() => params.set('sort', toggled('hireDate'))}
                  >
                    Hire date
                  </SortableTh>
                  <Th icon={CheckmarkBadge01Icon}>Status</Th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((caregiver) => (
                  <tr
                    key={caregiver.userId}
                    className="ds-table__row--link"
                    onClick={() => {
                      void navigate(`/caregivers/${caregiver.userId}`);
                    }}
                  >
                    <td>
                      <Link
                        to={`/caregivers/${caregiver.userId}`}
                        className="ds-table__link"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {caregiver.fullName}
                      </Link>
                    </td>
                    <td>{caregiver.employeeNumber ?? '-'}</td>
                    <td>{caregiver.hireDate ?? '-'}</td>
                    <td>
                      <Badge tone={caregiver.active ? 'success' : 'neutral'}>
                        {caregiver.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                  </tr>
                ))}
                {query.data.items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="ds-table__empty">
                      {status
                        ? 'No caregivers match these filters.'
                        : 'No caregivers registered yet.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableFrame>

          <div className="caregivers-page__pagination">
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

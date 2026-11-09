// Consent register: every active caregiver and dependant's location and visit-audio consent - who
// granted it, who revoked it - and visits still booked for someone whose location consent was
// revoked after booking, since those visits can't be verified.

import {
  Alert02Icon,
  Location01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  FilterIcon,
  Mic01Icon,
  MinusSignCircleIcon,
  UserIcon,
  UserMultipleIcon,
} from '@hugeicons/core-free-icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ConsentState } from '../../api/compliance';
import { useApi } from '../../api/useApi';
import { FilterBar, FilterMenu } from '../../design-system/FilterMenu';
import { TableSkeleton } from '../../design-system/Skeleton';
import { TableFrame, Th } from '../../design-system/Table';
import { useListParams } from '../../hooks/useListParams';
import { date } from './format';
import { Flag, StateMark } from './Marks';

function Consent({ state }: { state: ConsentState }) {
  if (state.status === 'active') {
    return (
      <span className="compliance__resolution">
        <StateMark icon={CheckmarkCircle02Icon} tone="ok">
          Given
        </StateMark>
        <span className="compliance__by">
          {state.grantedByName}
          {state.grantedAt ? `, ${date(state.grantedAt)}` : ''}
        </span>
      </span>
    );
  }
  if (state.status === 'revoked') {
    return (
      <span className="compliance__resolution">
        <StateMark icon={CancelCircleIcon} tone="problem">
          Revoked
        </StateMark>
        <span className="compliance__by">
          {state.revokedByName ?? 'Unknown'}
          {state.revokedAt ? `, ${date(state.revokedAt)}` : ''}
        </span>
      </span>
    );
  }
  return (
    <StateMark icon={MinusSignCircleIcon} tone="problem">
      Not given
    </StateMark>
  );
}

export function ConsentReport() {
  const { compliance } = useApi();
  const params = useListParams();
  const subjectType = params.oneOf('subjectType', ['', 'caregiver', 'dependant'] as const, '');
  const status = params.oneOf('status', ['', 'missing', 'complete'] as const, '');

  const query = useQuery({
    queryKey: ['compliance', 'consents', { subjectType, status }],
    queryFn: () =>
      compliance.getConsentRegister({
        subjectType: subjectType || undefined,
        status: status || undefined,
      }),
  });
  const filtered = Boolean(subjectType || status);

  return (
    <>
      <FilterBar onClear={filtered ? () => params.clear(['subjectType', 'status']) : undefined}>
        <FilterMenu
          label="Person"
          icon={UserMultipleIcon}
          value={subjectType}
          allLabel="Caregivers and dependants"
          options={[
            { value: 'caregiver', label: 'Caregivers' },
            { value: 'dependant', label: 'Dependants' },
          ]}
          onChange={(value) => params.set('subjectType', value)}
        />
        <FilterMenu
          label="Consent"
          icon={FilterIcon}
          value={status}
          allLabel="Any consent"
          options={[
            { value: 'missing', label: 'Something missing' },
            { value: 'complete', label: 'All given' },
          ]}
          onChange={(value) => params.set('status', value)}
        />
      </FilterBar>

      {query.isLoading ? <TableSkeleton columns={5} /> : null}
      {query.isError ? (
        <p className="compliance__message">The register couldn't be loaded.</p>
      ) : null}
      {query.data ? (
        <TableFrame>
          <table className="ds-table ds-table--table-cell">
            <thead>
              <tr>
                <Th icon={UserIcon}>Name</Th>
                <Th>Role</Th>
                <Th icon={Location01Icon}>Location checks</Th>
                <Th icon={Mic01Icon}>Visit audio</Th>
                <Th icon={Alert02Icon} className="compliance__num">
                  Visits at risk
                </Th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((row) => (
                <tr key={`${row.subjectType}:${row.subjectId}`}>
                  <td>
                    <Link
                      className="ds-table__link"
                      to={`/${row.subjectType === 'caregiver' ? 'caregivers' : 'dependants'}/${row.subjectId}`}
                    >
                      {row.name}
                    </Link>
                  </td>
                  <td>{row.subjectType === 'caregiver' ? 'Caregiver' : 'Dependant'}</td>
                  <td>
                    <Consent state={row.consents.location_verification} />
                  </td>
                  <td>
                    <Consent state={row.consents.visit_audio} />
                  </td>
                  <td className="compliance__num">
                    <Flag
                      count={row.upcomingVisitsWithoutConsent}
                      icon={Alert02Icon}
                      label="upcoming visits without location consent"
                    />
                  </td>
                </tr>
              ))}
              {query.data.items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="ds-table__empty">
                    {filtered ? 'Nobody matches these filters.' : 'Nobody is registered yet.'}
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

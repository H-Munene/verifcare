// Terms acceptance: how many of each app's active users have accepted the current terms of use and
// privacy notice, and who hasn't - they'll be asked the next time they open the app.

import {
  Calendar03Icon,
  CheckmarkCircle02Icon,
  ContractsIcon,
  HelpCircleIcon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../api/useApi';
import { Skeleton, SkeletonRegion, TableSkeleton } from '../../design-system/Skeleton';
import { StatTiles } from '../../design-system/StatTiles';
import { TableFrame, Th } from '../../design-system/Table';
import { date } from './format';
import { StateMark } from './Marks';

const APP_NAMES = { caregiver: 'Caregiver app', family_member: 'Family app' } as const;

export function TermsReport() {
  const { compliance } = useApi();
  const query = useQuery({
    queryKey: ['compliance', 'terms'],
    queryFn: () => compliance.getTermsReport(),
  });

  if (query.isError) {
    return <p className="compliance__message">The report couldn't be loaded.</p>;
  }
  if (!query.data) {
    return (
      <>
        <SkeletonRegion label="Loading terms acceptance" className="compliance__tiles-skeleton">
          <Skeleton height={96} radius={0} />
        </SkeletonRegion>
        <TableSkeleton columns={4} />
      </>
    );
  }
  const documents = query.data.documents;
  const users = documents.flatMap((doc) =>
    doc.users.map((user) => ({ ...user, document: doc.document, version: doc.currentVersion })),
  );
  // Those still to accept first, then by name, across both apps.
  users.sort(
    (a, b) => Number(a.acceptedCurrent) - Number(b.acceptedCurrent) || a.name.localeCompare(b.name),
  );

  return (
    <>
      <StatTiles
        label="Acceptance of the current terms"
        tiles={documents.map((doc) => ({
          label: `${APP_NAMES[doc.document]}, version ${doc.currentVersion}`,
          value: doc.activeUsers > 0 ? `${doc.acceptedCurrent} of ${doc.activeUsers}` : '0',
          detail:
            doc.activeUsers === 0
              ? 'No active users'
              : doc.acceptedCurrent === doc.activeUsers
                ? 'Everyone has accepted'
                : `${doc.activeUsers - doc.acceptedCurrent} still to accept`,
        }))}
      />

      <TableFrame>
        <table className="ds-table ds-table--table-cell">
          <thead>
            <tr>
              <Th icon={UserIcon}>Name</Th>
              <Th>App</Th>
              <Th icon={ContractsIcon}>Current terms</Th>
              <Th icon={Calendar03Icon}>Last accepted</Th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={`${user.document}:${user.userId}`}>
                <td>{user.name}</td>
                <td>{APP_NAMES[user.document]}</td>
                <td>
                  {user.acceptedCurrent ? (
                    <StateMark icon={CheckmarkCircle02Icon} tone="ok">
                      Accepted
                    </StateMark>
                  ) : (
                    <StateMark icon={HelpCircleIcon} tone="problem">
                      Not yet accepted
                    </StateMark>
                  )}
                </td>
                <td>
                  {user.lastAcceptedAt
                    ? `Version ${user.lastAcceptedVersion ?? '?'}, ${date(user.lastAcceptedAt)}`
                    : 'Never'}
                </td>
              </tr>
            ))}
            {users.length === 0 ? (
              <tr>
                <td colSpan={4} className="ds-table__empty">
                  No caregivers or family members use the apps yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </TableFrame>
    </>
  );
}

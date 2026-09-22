import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import './CaregiversListPage.css';

export function CaregiversListPage() {
  const { caregivers } = useApi();
  const { identity } = useAuth();
  const navigate = useNavigate();
  // Simple back/forward cursor history - mirrors DependantsListPage.tsx's identical pattern.
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const currentCursor = cursorStack[cursorStack.length - 1];

  const query = useQuery({
    queryKey: ['caregivers', currentCursor],
    queryFn: () => caregivers.listCaregivers({ cursor: currentCursor, limit: 20 }),
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

      {query.isLoading ? <p>Loading...</p> : null}
      {query.isError ? <p>Failed to load caregivers.</p> : null}

      {query.data ? (
        <>
          <table className="ds-table ds-table--table-cell">
            <thead>
              <tr>
                <th>Name</th>
                <th>Employee #</th>
                <th>Hire date</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((caregiver) => (
                <tr
                  key={caregiver.userId}
                  className="caregivers-page__row"
                  onClick={() => {
                    void navigate(`/caregivers/${caregiver.userId}`);
                  }}
                >
                  <td>{caregiver.fullName}</td>
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
                  <td colSpan={4} className="caregivers-page__empty">
                    No caregivers registered yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <div className="caregivers-page__pagination">
            <Button
              disabled={cursorStack.length <= 1}
              onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              disabled={!query.data.nextCursor}
              onClick={() =>
                setCursorStack((stack) => [...stack, query.data?.nextCursor ?? undefined])
              }
            >
              Next
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { Switch } from '../design-system/Switch';
import './DependantsListPage.css';

export function DependantsListPage() {
  const { dependants } = useApi();
  const { identity } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Simple back/forward cursor history - this list is small and bounded (cursor pagination, per
  // pagination.ts's design), so a plain stack is enough rather than a full pagination library.
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const currentCursor = cursorStack[cursorStack.length - 1];

  const query = useQuery({
    queryKey: ['dependants', currentCursor],
    queryFn: () => dependants.listDependants({ cursor: currentCursor, limit: 20 }),
  });

  const toggleMonitoring = useMutation({
    mutationFn: (params: { id: string; enabled: boolean }) =>
      dependants.updateDependant(params.id, { cognitiveMonitoringEnabled: params.enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dependants'] });
    },
  });

  return (
    <div>
      <div className="dependants-page__toolbar">
        <h1 className="dependants-page__title">Dependants</h1>
        <div className="dependants-page__toolbar-actions">
          {identity?.role === 'supervisor' ? (
            <Button
              onClick={() => {
                void navigate('/flagged-enrollments');
              }}
            >
              Flagged Enrollments
            </Button>
          ) : null}
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

      {query.isLoading ? <p>Loading...</p> : null}
      {query.isError ? <p>Failed to load dependants.</p> : null}

      {query.data ? (
        <>
          <table className="ds-table ds-table--table-cell">
            <thead>
              <tr>
                <th>Name</th>
                <th>DOB</th>
                <th>Gender</th>
                <th>Cognitive Monitoring</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((dependant) => (
                <tr
                  key={dependant.id}
                  className="dependants-page__row"
                  onClick={() => {
                    void navigate(`/dependants/${dependant.id}`);
                  }}
                >
                  <td>{dependant.fullName}</td>
                  <td>{dependant.dob}</td>
                  <td>{dependant.gender ?? '-'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Switch
                      checked={dependant.cognitiveMonitoringEnabled}
                      disabled={toggleMonitoring.isPending}
                      onChange={(enabled) => toggleMonitoring.mutate({ id: dependant.id, enabled })}
                    />
                  </td>
                  <td>
                    <Badge tone={dependant.status === 'active' ? 'success' : 'neutral'}>
                      {dependant.status}
                    </Badge>
                  </td>
                </tr>
              ))}
              {query.data.items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="dependants-page__empty">
                    No dependants registered yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          <div className="dependants-page__pagination">
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

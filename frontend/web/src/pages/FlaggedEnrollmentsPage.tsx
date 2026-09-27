import {
  Image01Icon,
  PercentCircleIcon,
  UserIcon,
  UserMultipleIcon,
} from '@hugeicons/core-free-icons';
import { TableFrame, Th } from '../design-system/Table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import './FlaggedEnrollmentsPage.css';
import { TableSkeleton } from '../design-system/Skeleton';

// New page (not part of the original wireframe's 7 sections - see components/AppShell.tsx's own
// note on that), reachable via a link from DependantDetailPage/DependantsListPage rather than a
// new sidebar item, so the shell's wireframe-matched nav stays honest about what's really there.
// GET /biometric-enrollments/flagged is supervisor-only (backend/src/routes/biometricEnrollments.ts),
// gated here the same way, not just left to the API to reject.
export function FlaggedEnrollmentsPage() {
  const { identity } = useAuth();
  const { biometricEnrollments } = useApi();
  const queryClient = useQueryClient();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const currentCursor = cursorStack[cursorStack.length - 1];

  const query = useQuery({
    queryKey: ['flagged-enrollments', currentCursor],
    queryFn: () => biometricEnrollments.listFlagged({ cursor: currentCursor, limit: 20 }),
    enabled: identity?.role === 'supervisor',
  });

  const approve = useMutation({
    mutationFn: (id: string) => biometricEnrollments.approveEnrollment(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['flagged-enrollments'] }),
  });
  const reject = useMutation({
    mutationFn: (id: string) => biometricEnrollments.rejectEnrollment(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['flagged-enrollments'] }),
  });

  if (identity?.role !== 'supervisor') {
    return <p>This page is supervisor-only.</p>;
  }

  return (
    <div>
      <div className="flagged-enrollments-page__toolbar">
        <h1 className="flagged-enrollments-page__title">Photo reviews</h1>
      </div>
      <p className="flagged-enrollments-page__intro">
        Each row's face matched an already-enrolled subject above the duplicate-detection threshold
        at confirm time (Linear HEZ-85) - approve to activate it anyway, or reject to mark it a
        genuine duplicate.
      </p>

      {query.isLoading ? <TableSkeleton columns={5} /> : null}
      {query.isError ? <p>Failed to load flagged enrollments.</p> : null}

      {query.data ? (
        <>
          <TableFrame>
            <table className="ds-table ds-table--table-cell">
              <thead>
                <tr>
                  <Th icon={UserIcon}>Subject</Th>
                  <Th icon={Image01Icon}>Image</Th>
                  <Th icon={UserMultipleIcon}>Matched subject</Th>
                  <Th icon={PercentCircleIcon}>Similarity</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((enrollment) => (
                  <tr key={enrollment.id}>
                    <td>
                      <SubjectLabel
                        subjectType={enrollment.subjectType}
                        subjectId={enrollment.caregiverId ?? enrollment.dependantId ?? ''}
                      />
                    </td>
                    <td>{enrollment.imageOrder}</td>
                    <td>
                      {enrollment.matchedSubjectType && enrollment.matchedSubjectId ? (
                        <SubjectLabel
                          subjectType={enrollment.matchedSubjectType}
                          subjectId={enrollment.matchedSubjectId}
                        />
                      ) : (
                        '-'
                      )}
                    </td>
                    <td>
                      <Badge tone="danger">
                        {enrollment.matchedSimilarity?.toFixed(1) ?? 'n/a'}%
                      </Badge>
                    </td>
                    <td className="flagged-enrollments-page__actions">
                      <Button
                        variant="primary"
                        disabled={approve.isPending || reject.isPending}
                        onClick={() => approve.mutate(enrollment.id)}
                      >
                        Approve
                      </Button>
                      <Button
                        disabled={approve.isPending || reject.isPending}
                        onClick={() => reject.mutate(enrollment.id)}
                      >
                        Reject
                      </Button>
                    </td>
                  </tr>
                ))}
                {query.data.items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="ds-table__empty">
                      Nothing flagged right now.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableFrame>

          <div className="flagged-enrollments-page__pagination">
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

// Resolves a dependant's name via GET /dependants/{id} (already available here). Caregivers have
// no equivalent frontend API module yet (Linear HEZ-54, the caregiver management UI, isn't built)
// - shown as a raw id with a role label instead of guessing at a lookup that doesn't exist.
function SubjectLabel({ subjectType, subjectId }: { subjectType: string; subjectId: string }) {
  const { dependants } = useApi();
  const dependantQuery = useQuery({
    queryKey: ['dependant', subjectId],
    queryFn: () => dependants.getDependant(subjectId),
    enabled: subjectType === 'dependant',
  });

  if (subjectType === 'dependant') {
    return <span>{dependantQuery.data?.fullName ?? subjectId}</span>;
  }
  return <span>{subjectId} (caregiver)</span>;
}

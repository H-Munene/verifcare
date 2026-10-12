import {
  Calendar03Icon,
  Image01Icon,
  PercentCircleIcon,
  UserIcon,
  UserMultipleIcon,
} from '@hugeicons/core-free-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { FlaggedBiometricEnrollment, SubjectType } from '../api/biometricEnrollments';
import { ApiError } from '../api/client';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { ConfirmDialog } from '../design-system/ConfirmDialog';
import { SidePanel } from '../design-system/SidePanel';
import { TableSkeleton } from '../design-system/Skeleton';
import { TableFrame, Th } from '../design-system/Table';
import './FlaggedEnrollmentsPage.css';

// The Reviews page (route /reviews): photos flagged at upload as looking like someone already
// enrolled (HEZ-85). GET /biometric-enrollments/flagged is supervisor-only
// (backend/src/routes/biometricEnrollments.ts), gated here the same way, not just left to the API
// to reject.
//
// Since 2026-09-27 (user request) a row opens a side panel that puts the flagged photo next to the
// matched person's current photo with the similarity, so a supervisor compares the two faces
// instead of approving or rejecting blind. Approve and Reject live only in that panel, each behind
// a confirmation, since neither can be undone from the console.

const ROLE_LABELS: Record<SubjectType, string> = { caregiver: 'Caregiver', dependant: 'Dependant' };

function subjectIdOf(enrollment: FlaggedBiometricEnrollment): string {
  return enrollment.caregiverId ?? enrollment.dependantId ?? '';
}

function personPath(subjectType: SubjectType, id: string): string {
  return subjectType === 'caregiver' ? `/caregivers/${id}` : `/dependants/${id}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-KE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function PersonCell({ name, subjectType }: { name: string | null; subjectType: SubjectType }) {
  return (
    <span className="flagged-enrollments-page__person">
      <span>{name ?? `Unknown ${subjectType}`}</span>
      <span className="flagged-enrollments-page__role">{ROLE_LABELS[subjectType]}</span>
    </span>
  );
}

export function FlaggedEnrollmentsPage() {
  const { identity } = useAuth();
  const { biometricEnrollments } = useApi();
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const currentCursor = cursorStack[cursorStack.length - 1];
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['flagged-enrollments', currentCursor],
    queryFn: () => biometricEnrollments.listFlagged({ cursor: currentCursor, limit: 20 }),
    enabled: identity?.role === 'supervisor',
  });
  const open = query.data?.items.find((e) => e.id === openId);

  if (identity?.role !== 'supervisor') {
    return <p>This page is supervisor-only.</p>;
  }

  return (
    <div>
      <p className="flagged-enrollments-page__intro">
        Each photo here looked like someone already enrolled when it was uploaded, so check-in
        isn&rsquo;t using it yet. Open one to compare the two faces, then approve it if
        they&rsquo;re different people or reject it if it&rsquo;s the same person enrolled twice.
      </p>

      {query.isLoading ? <TableSkeleton columns={5} /> : null}
      {query.isError ? <p>Failed to load flagged photos.</p> : null}

      {query.data ? (
        <>
          <TableFrame>
            <table className="ds-table ds-table--table-cell">
              <thead>
                <tr>
                  <Th icon={Image01Icon}>Photo</Th>
                  <Th icon={UserIcon}>Uploaded for</Th>
                  <Th icon={UserMultipleIcon}>Looks like</Th>
                  <Th icon={PercentCircleIcon}>Similarity</Th>
                  <Th icon={Calendar03Icon}>Uploaded</Th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((enrollment) => (
                  <tr
                    key={enrollment.id}
                    className="ds-table__row--link"
                    onClick={() => setOpenId(enrollment.id)}
                  >
                    <td className="flagged-enrollments-page__thumb-cell">
                      {/* A real button, so the keyboard reaches what the row's click does. */}
                      <button
                        type="button"
                        className="flagged-enrollments-page__open"
                        aria-haspopup="dialog"
                        aria-label={`Review the photo uploaded for ${enrollment.subjectName ?? `this ${enrollment.subjectType}`}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenId(enrollment.id);
                        }}
                      >
                        <img
                          className="flagged-enrollments-page__thumb"
                          src={enrollment.imageUrl}
                          alt=""
                        />
                      </button>
                    </td>
                    <td>
                      <PersonCell
                        name={enrollment.subjectName}
                        subjectType={enrollment.subjectType}
                      />
                    </td>
                    <td>
                      {enrollment.matchedSubjectType ? (
                        <PersonCell
                          name={enrollment.matchedSubjectName}
                          subjectType={enrollment.matchedSubjectType}
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
                    <td>{formatDate(enrollment.enrolledAt)}</td>
                  </tr>
                ))}
                {query.data.items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="ds-table__empty">
                      Nothing to review right now.
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

      {open ? <ReviewPanel enrollment={open} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

function ReviewPanel({
  enrollment,
  onClose,
}: {
  enrollment: FlaggedBiometricEnrollment;
  onClose: () => void;
}) {
  const { biometricEnrollments } = useApi();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);

  const subjectId = subjectIdOf(enrollment);
  const subjectName = enrollment.subjectName ?? `this ${enrollment.subjectType}`;
  const matchedType = enrollment.matchedSubjectType;
  const matchedName =
    enrollment.matchedSubjectName ?? (matchedType ? `the ${matchedType}` : 'someone');

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      decision === 'approve'
        ? biometricEnrollments.approveEnrollment(enrollment.id)
        : biometricEnrollments.rejectEnrollment(enrollment.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['flagged-enrollments'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
      // The person's photo and check-in photo status may have changed.
      void queryClient.invalidateQueries({ queryKey: [enrollment.subjectType, subjectId] });
      onClose();
    },
  });

  const details: [string, ReactNode][] = [
    [
      'Uploaded for',
      <Link key="s" to={personPath(enrollment.subjectType, subjectId)}>
        {enrollment.subjectName ?? 'Unknown'} ({ROLE_LABELS[enrollment.subjectType].toLowerCase()})
      </Link>,
    ],
    [
      'Looks like',
      matchedType && enrollment.matchedSubjectId ? (
        <Link key="m" to={personPath(matchedType, enrollment.matchedSubjectId)}>
          {enrollment.matchedSubjectName ?? 'Unknown'} ({ROLE_LABELS[matchedType].toLowerCase()})
        </Link>
      ) : (
        'Unknown'
      ),
    ],
    ['Photo quality', enrollment.qualityScore?.toFixed(1) ?? 'Not scored'],
    ['Uploaded on', formatDate(enrollment.enrolledAt)],
  ];

  const errorMessage = decide.error
    ? decide.error instanceof ApiError
      ? (decide.error.problem.detail ?? decide.error.problem.title)
      : 'Something went wrong. Try again.'
    : undefined;

  return (
    <SidePanel
      eyebrow="Photo review"
      title={enrollment.subjectName ?? `Unknown ${enrollment.subjectType}`}
      onClose={onClose}
      footer={
        <div className="flagged-enrollments-page__panel-actions">
          <Button onClick={() => setConfirming('reject')}>Reject</Button>
          <Button variant="primary" onClick={() => setConfirming('approve')}>
            Approve
          </Button>
        </div>
      }
    >
      <div className="flagged-enrollments-page__compare">
        <figure className="flagged-enrollments-page__figure">
          <img
            src={enrollment.imageUrl}
            alt={`Flagged photo uploaded for ${subjectName}`}
            className="flagged-enrollments-page__photo"
          />
          <figcaption>
            <span className="flagged-enrollments-page__caption-label">New photo</span>
            <span>{enrollment.subjectName ?? 'Unknown'}</span>
          </figcaption>
        </figure>
        <figure className="flagged-enrollments-page__figure">
          {enrollment.matchedImageUrl ? (
            <img
              src={enrollment.matchedImageUrl}
              alt={`Current photo of ${matchedName}`}
              className="flagged-enrollments-page__photo"
            />
          ) : (
            <div className="flagged-enrollments-page__photo flagged-enrollments-page__photo--none">
              No current photo on file
            </div>
          )}
          <figcaption>
            <span className="flagged-enrollments-page__caption-label">Already enrolled</span>
            <span>{enrollment.matchedSubjectName ?? 'Unknown'}</span>
          </figcaption>
        </figure>
      </div>
      <div className="flagged-enrollments-page__similarity">
        <span className="flagged-enrollments-page__similarity-value">
          {enrollment.matchedSimilarity?.toFixed(1) ?? 'n/a'}%
        </span>
        <span>similar faces</span>
      </div>

      <p className="flagged-enrollments-page__guidance">
        Relatives can look very alike. Approve if these are two different people; reject if
        it&rsquo;s {matchedName} enrolled again as {subjectName}.
      </p>

      <dl className="flagged-enrollments-page__details">
        {details.map(([label, value]) => (
          <div key={label} className="flagged-enrollments-page__detail">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {confirming === 'approve' ? (
        <ConfirmDialog
          title="Approve this photo?"
          message={
            <p>
              Only approve if {subjectName} and {matchedName} are different people. The photo
              becomes {subjectName}&rsquo;s check-in photo and replaces any current one.
            </p>
          }
          confirmLabel="Approve photo"
          pendingLabel="Approving..."
          pending={decide.isPending}
          error={errorMessage}
          onConfirm={() => decide.mutate('approve')}
          onCancel={() => {
            setConfirming(null);
            decide.reset();
          }}
        />
      ) : null}
      {confirming === 'reject' ? (
        <ConfirmDialog
          title="Reject this photo?"
          message={
            <p>
              Reject if this is {matchedName} enrolled again as {subjectName}. The photo is
              discarded, and {subjectName} keeps their current photo, if they have one.
            </p>
          }
          confirmLabel="Reject photo"
          pendingLabel="Rejecting..."
          destructive
          pending={decide.isPending}
          error={errorMessage}
          onConfirm={() => decide.mutate('reject')}
          onCancel={() => {
            setConfirming(null);
            decide.reset();
          }}
        />
      ) : null}
    </SidePanel>
  );
}

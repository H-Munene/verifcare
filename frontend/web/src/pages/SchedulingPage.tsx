import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import type { Caregiver } from '../api/caregivers';
import type { Dependant } from '../api/dependants';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import type { BadgeTone } from '../design-system/Badge';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { Label } from '../design-system/Input';
import { Modal } from '../design-system/Modal';
import type { VisitSchedule, VisitStatus } from '../api/visitSchedules';
import './SchedulingPage.css';

// 07a "Scheduling — Agenda" (temp_images's wireframe canvas). GET /visit-schedules only returns
// caregiverId/dependantId, not names (HEZ-32's contract), so the caregiver/dependant lists are
// fetched here too, purely to build id->name lookup maps and to populate 07b's two selects - not
// re-derived server-side, since a supervisor already has full GET access to both resources
// (unlike the caregiver-app gap docs/caregiver-checkin-geofence-plan.md raised for a different
// role). limit:100 - a POC-scale fetch-everything, not real pagination through every caregiver/
// dependant that exists (matches architecture.md's own "cost-conscious academic PoC" framing).
function statusTone(status: VisitStatus): BadgeTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'missed':
    case 'investigated':
      return 'danger';
    default:
      return 'neutral';
  }
}

function formatWindow(scheduledStart: string, scheduledEnd: string): string {
  const start = new Date(scheduledStart);
  const end = new Date(scheduledEnd);
  const dateLabel = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${dateLabel}, ${start.toLocaleTimeString(undefined, timeOpts)} - ${end.toLocaleTimeString(undefined, timeOpts)}`;
}

export function SchedulingPage() {
  const { visitSchedules, caregivers, dependants } = useApi();
  const { identity } = useAuth();
  const queryClient = useQueryClient();
  // AppShell already hides the nav entry point for a non-supervisor (POST/PATCH
  // /visit-schedules are supervisor-only), same as RegisterCaregiverPage's own precedent - this
  // guards direct URL access too, with a clear message instead of a confusing failed request.
  const isSupervisor = identity?.role === 'supervisor';
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const currentCursor = cursorStack[cursorStack.length - 1];
  const [modalState, setModalState] = useState<
    { mode: 'create' } | { mode: 'edit'; visit: VisitSchedule } | null
  >(null);

  const caregiversQuery = useQuery({
    queryKey: ['caregivers', 'for-scheduling'],
    queryFn: () => caregivers.listCaregivers({ active: true, limit: 100 }),
    enabled: isSupervisor,
  });
  const dependantsQuery = useQuery({
    queryKey: ['dependants', 'for-scheduling'],
    queryFn: () => dependants.listDependants({ status: 'active', limit: 100 }),
    enabled: isSupervisor,
  });
  const schedulesQuery = useQuery({
    queryKey: ['visit-schedules', currentCursor],
    queryFn: () => visitSchedules.listVisitSchedules({ cursor: currentCursor, limit: 20 }),
    enabled: isSupervisor,
  });

  const caregiverNames = new Map(
    (caregiversQuery.data?.items ?? []).map((c) => [c.userId, c.fullName]),
  );
  const dependantNames = new Map(
    (dependantsQuery.data?.items ?? []).map((d) => [d.id, d.fullName]),
  );

  const cancelMutation = useMutation({
    mutationFn: (visitScheduleId: string) =>
      visitSchedules.updateVisitSchedule(visitScheduleId, { status: 'cancelled' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['visit-schedules'] }),
  });

  // Display-only re-sort by start time within the fetched page - GET /visit-schedules orders by
  // id (UUID v7, i.e. creation order) to keep cursor pagination correct, not by scheduledStart, so
  // an "agenda" reading benefits from a client-side re-sort of just what's on screen.
  const rows = [...(schedulesQuery.data?.items ?? [])].sort(
    (a, b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
  );

  if (!isSupervisor) {
    return <p>Only supervisors can view or manage scheduling.</p>;
  }

  return (
    <div>
      <div className="scheduling-page__toolbar">
        <h1 className="scheduling-page__title">Scheduling</h1>
        <Button variant="cta-pill" onClick={() => setModalState({ mode: 'create' })}>
          + Schedule Visit
        </Button>
      </div>

      {schedulesQuery.isLoading ? <p>Loading...</p> : null}
      {schedulesQuery.isError ? <p>Failed to load visit schedules.</p> : null}

      {schedulesQuery.data ? (
        <>
          <div className="scheduling-page__list">
            {rows.map((visit) => (
              <div key={visit.id} className="scheduling-page__row">
                <div className="scheduling-page__row-main">
                  {caregiverNames.get(visit.caregiverId) ?? 'Unknown caregiver'}{' '}
                  <span className="scheduling-page__arrow">→</span>{' '}
                  {dependantNames.get(visit.dependantId) ?? 'Unknown dependant'}
                </div>
                <div className="scheduling-page__row-window">
                  {formatWindow(visit.scheduledStart, visit.scheduledEnd)}
                </div>
                <Badge tone={statusTone(visit.status)}>{visit.status.replace('_', ' ')}</Badge>
                <Button
                  disabled={visit.status !== 'scheduled'}
                  onClick={() => setModalState({ mode: 'edit', visit })}
                >
                  Edit
                </Button>
                <Button
                  disabled={visit.status !== 'scheduled' || cancelMutation.isPending}
                  onClick={() => cancelMutation.mutate(visit.id)}
                >
                  Cancel
                </Button>
              </div>
            ))}
            {rows.length === 0 ? (
              <div className="scheduling-page__empty">No visits scheduled yet.</div>
            ) : null}
          </div>

          {cancelMutation.error ? (
            <div className="scheduling-page__error">
              {cancelMutation.error instanceof ApiError
                ? (cancelMutation.error.problem.detail ?? cancelMutation.error.problem.title)
                : 'Something went wrong.'}
            </div>
          ) : null}

          <div className="scheduling-page__pagination">
            <Button
              disabled={cursorStack.length <= 1}
              onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              disabled={!schedulesQuery.data.nextCursor}
              onClick={() =>
                setCursorStack((stack) => [...stack, schedulesQuery.data?.nextCursor ?? undefined])
              }
            >
              Next
            </Button>
          </div>
        </>
      ) : null}

      {modalState ? (
        <ScheduleVisitModal
          mode={modalState.mode}
          existing={modalState.mode === 'edit' ? modalState.visit : undefined}
          caregiverOptions={caregiversQuery.data?.items ?? []}
          dependantOptions={dependantsQuery.data?.items ?? []}
          onClose={() => setModalState(null)}
        />
      ) : null}
    </div>
  );
}

// Local datetime, not UTC - `<input type="datetime-local">` reads/writes the wall-clock value the
// supervisor actually sees, so this uses the Date object's local getters (getHours, not
// getUTCHours), unlike toISOString() (always UTC) which would silently shift the displayed time
// by the browser's UTC offset.
function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface ScheduleVisitModalProps {
  mode: 'create' | 'edit';
  existing?: VisitSchedule;
  caregiverOptions: Caregiver[];
  dependantOptions: Dependant[];
  onClose: () => void;
}

// 07b "Schedule Visit" (create) and its reschedule counterpart (Edit, from the agenda row) share
// this one form: caregiverId/dependantId aren't in PATCH /visit-schedules/{id}'s own contract (the
// backend has no "reassign caregiver/dependant" operation, only reschedule/cancel), so edit mode
// simply doesn't render those two fields rather than sending values the backend would ignore.
function ScheduleVisitModal({
  mode,
  existing,
  caregiverOptions,
  dependantOptions,
  onClose,
}: ScheduleVisitModalProps) {
  const { visitSchedules } = useApi();
  const queryClient = useQueryClient();
  const [caregiverId, setCaregiverId] = useState(existing?.caregiverId ?? '');
  const [dependantId, setDependantId] = useState(existing?.dependantId ?? '');
  const [start, setStart] = useState(existing ? toDatetimeLocalValue(existing.scheduledStart) : '');
  const [end, setEnd] = useState(existing ? toDatetimeLocalValue(existing.scheduledEnd) : '');

  const mutation = useMutation({
    mutationFn: () => {
      const scheduledStart = new Date(start).toISOString();
      const scheduledEnd = new Date(end).toISOString();
      if (mode === 'create') {
        return visitSchedules.createVisitSchedule({
          caregiverId,
          dependantId,
          scheduledStart,
          scheduledEnd,
        });
      }
      return visitSchedules.updateVisitSchedule(existing!.id, { scheduledStart, scheduledEnd });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['visit-schedules'] });
      onClose();
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <Modal title={mode === 'create' ? 'Schedule Visit' : 'Edit Visit'} onClose={onClose}>
      <form className="scheduling-page__modal-form" onSubmit={handleSubmit} autoComplete="off">
        {mode === 'create' ? (
          <>
            <div>
              <Label htmlFor="scheduleCaregiver" required>
                Caregiver
              </Label>
              <select
                id="scheduleCaregiver"
                className="ds-input"
                required
                value={caregiverId}
                onChange={(e) => setCaregiverId(e.target.value)}
              >
                <option value="">Select caregiver...</option>
                {caregiverOptions.map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {c.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="scheduleDependant" required>
                Dependant
              </Label>
              <select
                id="scheduleDependant"
                className="ds-input"
                required
                value={dependantId}
                onChange={(e) => setDependantId(e.target.value)}
              >
                <option value="">Select dependant...</option>
                {dependantOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fullName}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : null}
        <div className="scheduling-page__modal-row">
          <div>
            <Label htmlFor="scheduleStart" required>
              Start time
            </Label>
            <input
              id="scheduleStart"
              type="datetime-local"
              className="ds-input"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="scheduleEnd" required>
              End time
            </Label>
            <input
              id="scheduleEnd"
              type="datetime-local"
              className="ds-input"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
        </div>
        {mutation.error ? (
          <div className="scheduling-page__modal-error">
            {mutation.error instanceof ApiError
              ? (mutation.error.problem.detail ?? mutation.error.problem.title)
              : 'Something went wrong.'}
          </div>
        ) : null}
        <div className="scheduling-page__modal-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving...' : mode === 'create' ? 'Create' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
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
import './VisitsPage.css';

// Unifies the former Scheduling and Visits nav entries into one page (2026-09-23, user request):
// a "Schedule Visit" action plus a live table of every visit, the table's own status column doing
// double duty as what used to be two separate concerns (an agenda of upcoming visits, and a
// read-only visit list). caregiverDisplayName/dependantDisplayName come straight off
// VisitSchedule now (routes/visitSchedules.ts's own toResponse has included them since the
// caregiver mobile app's schedule calendar needed them) - no separate id->name lookup map built
// from a second caregivers/dependants fetch the way this page used to, for just the table. That
// second fetch is still needed for the Schedule Visit modal's own two selects, which genuinely
// need the full active caregiver/dependant lists, not just whichever names already appear in the
// current page of visits.
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

// "Checked In"/"Checked Out" read far more naturally in a visit table than the raw
// in_progress/completed status names - the underlying VisitStatus values are unchanged, this is
// display-only.
function statusLabel(status: VisitStatus): string {
  switch (status) {
    case 'in_progress':
      return 'Checked In';
    case 'completed':
      return 'Checked Out';
    default:
      return status.replace('_', ' ');
  }
}

function formatWindow(scheduledStart: string, scheduledEnd: string): string {
  const start = new Date(scheduledStart);
  const end = new Date(scheduledEnd);
  const dateLabel = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${dateLabel}, ${start.toLocaleTimeString(undefined, timeOpts)} - ${end.toLocaleTimeString(undefined, timeOpts)}`;
}

export function VisitsPage() {
  const { visitSchedules, caregivers, dependants } = useApi();
  const { identity } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Supervisor-only, same as the old Scheduling page - this app is the Supervisor Console (its own
  // login screen says so), so every main page here is already gated the same way, confirmed with
  // the user rather than widened to a read-only view for other roles.
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
    return <p>Only supervisors can view or manage visits.</p>;
  }

  return (
    <div>
      <div className="visits-page__toolbar">
        <h1 className="visits-page__title">Visits</h1>
        <Button variant="cta-pill" onClick={() => setModalState({ mode: 'create' })}>
          + Schedule Visit
        </Button>
      </div>

      {schedulesQuery.isLoading ? <p>Loading...</p> : null}
      {schedulesQuery.isError ? <p>Failed to load visits.</p> : null}

      {schedulesQuery.data ? (
        <>
          <table className="ds-table ds-table--table-cell">
            <thead>
              <tr>
                <th>Caregiver</th>
                <th>Dependant</th>
                <th>Scheduled window</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((visit) => (
                <tr
                  key={visit.id}
                  className="visits-page__row"
                  onClick={() => void navigate(`/visits/${visit.id}`)}
                >
                  <td>{visit.caregiverDisplayName}</td>
                  <td>{visit.dependantDisplayName}</td>
                  <td>{formatWindow(visit.scheduledStart, visit.scheduledEnd)}</td>
                  <td>
                    <Badge tone={statusTone(visit.status)}>{statusLabel(visit.status)}</Badge>
                  </td>
                  <td className="visits-page__row-actions">
                    <Button
                      disabled={visit.status !== 'scheduled'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setModalState({ mode: 'edit', visit });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      disabled={visit.status !== 'scheduled' || cancelMutation.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelMutation.mutate(visit.id);
                      }}
                    >
                      Cancel
                    </Button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="visits-page__empty">
                    No visits scheduled yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          {cancelMutation.error ? (
            <div className="visits-page__error">
              {cancelMutation.error instanceof ApiError
                ? (cancelMutation.error.problem.detail ?? cancelMutation.error.problem.title)
                : 'Something went wrong.'}
            </div>
          ) : null}

          <div className="visits-page__pagination">
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

// Create and reschedule (Edit, from the table row) share this one form: caregiverId/dependantId
// aren't in PATCH /visit-schedules/{id}'s own contract (the backend has no "reassign
// caregiver/dependant" operation, only reschedule/cancel), so edit mode simply doesn't render
// those two fields rather than sending values the backend would ignore.
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
      <form className="visits-page__modal-form" onSubmit={handleSubmit} autoComplete="off">
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
        <div className="visits-page__modal-row">
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
          <div className="visits-page__modal-error">
            {mutation.error instanceof ApiError
              ? (mutation.error.problem.detail ?? mutation.error.problem.title)
              : 'Something went wrong.'}
          </div>
        ) : null}
        <div className="visits-page__modal-actions">
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

import {
  Calendar03Icon,
  CheckmarkBadge01Icon,
  Delete02Icon,
  HandHeartIcon,
  PencilEdit02Icon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Caregiver } from '../api/caregivers';
import type { Dependant } from '../api/dependants';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { ActionMenu } from '../design-system/ActionMenu';
import { ConfirmDialog } from '../design-system/ConfirmDialog';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { Label } from '../design-system/Input';
import { Modal } from '../design-system/Modal';
import { TimeSelect } from '../design-system/TimeSelect';
import type { ListVisitSchedulesParams, VisitSchedule, VisitStatus } from '../api/visitSchedules';
import { FilterBar, FilterMenu } from '../design-system/FilterMenu';
import { sortState } from '../design-system/sortState';
import { SortableTh, TableFrame, Th } from '../design-system/Table';
import { useCursorPages } from '../hooks/useCursorPages';
import { useListParams } from '../hooks/useListParams';
import './VisitsPage.css';
import { TableSkeleton } from '../design-system/Skeleton';
import { statusLabel, statusTone } from '../components/visitStatus';
import { VisitPanel } from '../components/VisitPanel';

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

function formatWindow(scheduledStart: string, scheduledEnd: string): string {
  const start = new Date(scheduledStart);
  const end = new Date(scheduledEnd);
  const dateLabel = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${dateLabel}, ${start.toLocaleTimeString(undefined, timeOpts)} - ${end.toLocaleTimeString(undefined, timeOpts)}`;
}

type VisitSort = NonNullable<ListVisitSchedulesParams['sort']>;

const SORTS: readonly VisitSort[] = ['-scheduledStart', 'scheduledStart'];

const STATUS_OPTIONS: { value: VisitStatus; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'Checked In' },
  { value: 'completed', label: 'Checked Out' },
  { value: 'missed', label: 'Missed' },
  { value: 'investigated', label: 'Investigated' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'reassigned', label: 'Reassigned' },
];

// Date presets, as Nairobi days - the service's time zone, as on the Overview.
const DATE_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'next7', label: 'Next 7 days' },
  { value: 'past7', label: 'Past 7 days' },
] as const;
type DatePreset = (typeof DATE_OPTIONS)[number]['value'];

function nairobiDay(offsetDays: number): Date {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());
  const start = new Date(`${today}T00:00:00+03:00`);
  start.setUTCDate(start.getUTCDate() + offsetDays);
  return start;
}

/** The preset's first and last instants, for scheduledStartFrom/To (both inclusive). */
function dateRange(preset: DatePreset): { from: string; to: string } {
  // [first day, as an offset from today; number of days]
  const presets: Record<DatePreset, [number, number]> = {
    today: [0, 1],
    tomorrow: [1, 1],
    next7: [0, 7],
    past7: [-6, 7],
  };
  const [first, days] = presets[preset];
  const from = nairobiDay(first);
  const to = new Date(nairobiDay(first + days).getTime() - 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function VisitsPage() {
  const { visitSchedules, caregivers, dependants } = useApi();
  const { identity } = useAuth();
  const queryClient = useQueryClient();
  // Supervisor-only, same as the old Scheduling page - this app is the Supervisor Console (its own
  // login screen says so), so every main page here is already gated the same way, confirmed with
  // the user rather than widened to a read-only view for other roles.
  const isSupervisor = identity?.role === 'supervisor';
  // Filters and sort live in the URL and are applied by the server - see DependantsListPage.tsx.
  const params = useListParams();
  const status = params.oneOf('status', ['', ...STATUS_OPTIONS.map((o) => o.value)], '');
  const caregiverId = params.get('caregiver');
  const dependantId = params.get('dependant');
  const date = params.oneOf('date', ['', ...DATE_OPTIONS.map((o) => o.value)], '');
  const sort = params.oneOf('sort', SORTS, '-scheduledStart');
  const pages = useCursorPages(`${status}|${caregiverId}|${dependantId}|${date}|${sort}`);
  const { directionOf, toggled } = sortState<'scheduledStart'>(sort);
  // The visit in the side panel follows ?visit=<id> (2026-09-27: rows open a panel, not a page),
  // so any link to a visit opens it here. The row's visit is kept to show the panel at once.
  const panelVisitId = params.get('visit');
  const [clickedVisit, setClickedVisit] = useState<VisitSchedule | undefined>(undefined);
  function openVisit(visit: VisitSchedule) {
    setClickedVisit(visit);
    params.set('visit', visit.id);
  }
  const [modalState, setModalState] = useState<
    { mode: 'create' } | { mode: 'edit'; visit: VisitSchedule } | null
  >(null);

  // Active ones only: the Schedule Visit form's choices.
  const caregiversQuery = useQuery({
    queryKey: ['caregivers', 'for-scheduling'],
    queryFn: () => caregivers.listCaregivers({ active: true, sort: 'name', limit: 100 }),
    enabled: isSupervisor,
  });
  const dependantsQuery = useQuery({
    queryKey: ['dependants', 'for-scheduling'],
    queryFn: () => dependants.listDependants({ status: 'active', sort: 'name', limit: 100 }),
    enabled: isSupervisor,
  });
  // Everyone, for the filters: past visits can belong to someone since deactivated.
  // ponytail: the first 100 by name; a searchable server-side picker if either list outgrows it.
  const allCaregiversQuery = useQuery({
    queryKey: ['caregivers', 'for-filter'],
    queryFn: () => caregivers.listCaregivers({ sort: 'name', limit: 100 }),
    enabled: isSupervisor,
  });
  const allDependantsQuery = useQuery({
    queryKey: ['dependants', 'for-filter'],
    queryFn: () => dependants.listDependants({ sort: 'name', limit: 100 }),
    enabled: isSupervisor,
  });
  const range = date ? dateRange(date) : undefined;
  const schedulesQuery = useQuery({
    queryKey: [
      'visit-schedules',
      { status, caregiverId, dependantId, date, sort, cursor: pages.cursor },
    ],
    queryFn: () =>
      visitSchedules.listVisitSchedules({
        status: status || undefined,
        caregiverId: caregiverId || undefined,
        dependantId: dependantId || undefined,
        scheduledStartFrom: range?.from,
        scheduledStartTo: range?.to,
        sort,
        cursor: pages.cursor,
        limit: 20,
      }),
    enabled: isSupervisor,
  });

  // The visit waiting on "Cancel visit"'s confirmation (cancelling can't be undone from here).
  const [cancelling, setCancelling] = useState<VisitSchedule | null>(null);
  const cancelMutation = useMutation({
    mutationFn: (visitScheduleId: string) =>
      visitSchedules.updateVisitSchedule(visitScheduleId, { status: 'cancelled' }),
    onSuccess: () => {
      setCancelling(null);
      void queryClient.invalidateQueries({ queryKey: ['visit-schedules'] });
    },
  });

  if (!isSupervisor) {
    return <p>Only supervisors can view or manage visits.</p>;
  }

  const rows = schedulesQuery.data?.items ?? [];
  const filterKeys = ['status', 'caregiver', 'dependant', 'date'];
  const filtered = Boolean(status || caregiverId || dependantId || date);

  return (
    <div>
      <div className="visits-page__toolbar">
        <Button variant="cta-pill" onClick={() => setModalState({ mode: 'create' })}>
          + Schedule Visit
        </Button>
      </div>

      <FilterBar onClear={filtered ? () => params.clear(filterKeys) : undefined}>
        <FilterMenu
          label="Status"
          icon={CheckmarkBadge01Icon}
          value={status}
          allLabel="All statuses"
          options={STATUS_OPTIONS}
          onChange={(value) => params.set('status', value)}
        />
        <FilterMenu
          label="Caregiver"
          icon={UserIcon}
          value={caregiverId}
          allLabel="All caregivers"
          options={(allCaregiversQuery.data?.items ?? []).map((c) => ({
            value: c.userId,
            label: c.fullName,
          }))}
          searchPlaceholder="Search caregivers"
          onChange={(value) => params.set('caregiver', value)}
        />
        <FilterMenu
          label="Dependant"
          icon={HandHeartIcon}
          value={dependantId}
          allLabel="All dependants"
          options={(allDependantsQuery.data?.items ?? []).map((d) => ({
            value: d.id,
            label: d.fullName,
          }))}
          searchPlaceholder="Search dependants"
          onChange={(value) => params.set('dependant', value)}
        />
        <FilterMenu
          label="Date"
          icon={Calendar03Icon}
          value={date}
          allLabel="Any date"
          options={[...DATE_OPTIONS]}
          onChange={(value) => params.set('date', value)}
        />
      </FilterBar>

      {schedulesQuery.isLoading ? <TableSkeleton columns={5} /> : null}

      {schedulesQuery.data ? (
        <>
          <TableFrame>
            <table className="ds-table ds-table--table-cell">
              <thead>
                <tr>
                  <Th icon={UserIcon}>Caregiver</Th>
                  <Th icon={HandHeartIcon}>Dependant</Th>
                  <SortableTh
                    icon={Calendar03Icon}
                    direction={directionOf('scheduledStart')}
                    onSort={() => params.set('sort', toggled('scheduledStart'))}
                  >
                    Scheduled window
                  </SortableTh>
                  <Th icon={CheckmarkBadge01Icon}>Status</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((visit) => (
                  <tr
                    key={visit.id}
                    className="ds-table__row--link"
                    onClick={() => openVisit(visit)}
                  >
                    <td>
                      {/* A real link, so the keyboard reaches it and a new tab still opens the
                          full page; a plain click opens the panel. */}
                      <Link
                        to={`/visits?visit=${visit.id}`}
                        className="ds-table__link"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!event.metaKey && !event.ctrlKey && !event.shiftKey) {
                            event.preventDefault();
                            openVisit(visit);
                          }
                        }}
                      >
                        {visit.caregiverDisplayName}
                      </Link>
                    </td>
                    <td>{visit.dependantDisplayName}</td>
                    <td>{formatWindow(visit.scheduledStart, visit.scheduledEnd)}</td>
                    <td>
                      <Badge tone={statusTone(visit.status)}>{statusLabel(visit.status)}</Badge>
                    </td>
                    {/* Edit and Cancel behind a vertical ellipsis (user request). "Cancel visit",
                        not "Delete": the API cancels a visit and keeps its record. */}
                    <td className="visits-page__row-actions">
                      <ActionMenu
                        label={`Actions for the visit to ${visit.dependantDisplayName}`}
                        items={[
                          {
                            label: 'Edit',
                            icon: PencilEdit02Icon,
                            disabled: visit.status !== 'scheduled',
                            onSelect: () => setModalState({ mode: 'edit', visit }),
                          },
                          {
                            label: 'Cancel visit',
                            icon: Delete02Icon,
                            disabled: visit.status !== 'scheduled' || cancelMutation.isPending,
                            onSelect: () => {
                              cancelMutation.reset();
                              setCancelling(visit);
                            },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="ds-table__empty">
                      {filtered ? 'No visits match these filters.' : 'No visits scheduled yet.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableFrame>

          <div className="visits-page__pagination">
            <Button disabled={!pages.canGoBack} onClick={pages.back}>
              Previous
            </Button>
            <Button
              disabled={!schedulesQuery.data.nextCursor}
              onClick={() => {
                if (schedulesQuery.data.nextCursor) {
                  pages.next(schedulesQuery.data.nextCursor);
                }
              }}
            >
              Next
            </Button>
          </div>
        </>
      ) : null}

      {panelVisitId ? (
        <VisitPanel
          visitId={panelVisitId}
          visit={clickedVisit?.id === panelVisitId ? clickedVisit : undefined}
          onClose={() => params.set('visit', '')}
        />
      ) : null}

      {cancelling ? (
        <ConfirmDialog
          destructive
          title="Cancel this visit?"
          message={`${cancelling.caregiverDisplayName}'s visit to ${cancelling.dependantDisplayName} on ${formatWindow(
            cancelling.scheduledStart,
            cancelling.scheduledEnd,
          )} will be cancelled. It stays in the visit history as cancelled.`}
          confirmLabel="Cancel visit"
          cancelLabel="Keep visit"
          pending={cancelMutation.isPending}
          pendingLabel="Cancelling..."
          onConfirm={() => cancelMutation.mutate(cancelling.id)}
          onCancel={() => setCancelling(null)}
        />
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

// The visit's local date (YYYY-MM-DD) and time (HH:MM), for the form's date field and time
// pickers - the wall-clock values the supervisor sees, so the Date's local getters, not UTC ones.
function localParts(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function todayLocal(): string {
  return localParts(new Date().toISOString()).date;
}

/** An hour after [time] ("HH:MM"), capped at 23:55 so it stays on the same day. */
function anHourAfter(time: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number);
  const total = Math.min(h * 60 + m + 60, 23 * 60 + 55);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
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
  // A date and separate check-in and check-out times (user request, 2026-09-27), rather than two
  // date-and-time fields: a visit starts and ends on the same day.
  const [date, setDate] = useState(
    existing ? localParts(existing.scheduledStart).date : todayLocal(),
  );
  const [checkIn, setCheckIn] = useState(
    existing ? localParts(existing.scheduledStart).time : '09:00',
  );
  const [checkOut, setCheckOut] = useState(
    existing ? localParts(existing.scheduledEnd).time : '10:00',
  );
  const timesValid = checkOut > checkIn;

  const mutation = useMutation({
    mutationFn: () => {
      const scheduledStart = new Date(`${date}T${checkIn}`).toISOString();
      const scheduledEnd = new Date(`${date}T${checkOut}`).toISOString();
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
        <div>
          <Label htmlFor="scheduleDate" required>
            Date
          </Label>
          <input
            id="scheduleDate"
            type="date"
            className="ds-input"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        {/* One time per row: each picker needs the form's full width. */}
        <div>
          <span className="ds-label">Check-in</span>
          <TimeSelect
            label="Check-in time"
            value={checkIn}
            onChange={(value) => {
              setCheckIn(value);
              // Keep the visit at least a moment long: push check-out along with check-in.
              if (checkOut <= value) {
                setCheckOut(anHourAfter(value));
              }
            }}
          />
        </div>
        <div>
          <span className="ds-label">Check-out</span>
          <TimeSelect label="Check-out time" value={checkOut} onChange={setCheckOut} />
        </div>
        {!timesValid ? (
          <div className="visits-page__modal-error" role="alert">
            Check-out must be after check-in.
          </div>
        ) : null}
        <div className="visits-page__modal-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={mutation.isPending || !timesValid}>
            {mutation.isPending ? 'Saving...' : mode === 'create' ? 'Create' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

import {
  AlertCircleIcon,
  CheckmarkBadge01Icon,
  Tag01Icon,
  Task01Icon,
} from '@hugeicons/core-free-icons';
import { TableFrame, Th } from '../design-system/Table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import type { CareTask } from '../api/dependants';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { Input, Label } from '../design-system/Input';
import { Modal } from '../design-system/Modal';
import { Switch } from '../design-system/Switch';
import './CarePlanPage.css';
import { TableSkeleton } from '../design-system/Skeleton';

// docs/visit-task-checklist-plan.md section 4: a dedicated Care Plan screen, separate from
// dependant registration, per the user's own explicit choice - supervisor-authored tasks that the
// caregiver mobile app's check-in flow will later read and work through (mobile UI is separate,
// later work - this page only authors the plan, it doesn't show any visit's live completions).
export function CarePlanPage() {
  const { dependantId } = useParams<{ dependantId: string }>();
  const { dependants } = useApi();
  const { identity } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [modalState, setModalState] = useState<
    { mode: 'create' } | { mode: 'edit'; task: CareTask } | null
  >(null);

  // Same "hide what you can't use" treatment RegisterCaregiverPage/VisitsPage already give a
  // non-supervisor - authoring a care plan is supervisor-only per dependants.ts's own RBAC.
  const isSupervisor = identity?.role === 'supervisor';

  const dependantQuery = useQuery({
    queryKey: ['dependant', dependantId],
    queryFn: () => dependants.getDependant(dependantId!),
    enabled: isSupervisor,
  });
  const tasksQuery = useQuery({
    queryKey: ['dependant', dependantId, 'care-tasks'],
    queryFn: () => dependants.listCareTasks(dependantId!),
    enabled: isSupervisor,
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ taskId, active }: { taskId: string; active: boolean }) =>
      dependants.updateCareTask(dependantId!, taskId, { active }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['dependant', dependantId, 'care-tasks'] }),
  });

  if (!isSupervisor) {
    return <p>Only supervisors can view or manage a dependant's care plan.</p>;
  }

  return (
    <div>
      <div className="care-plan-page__toolbar">
        <div>
          <button
            type="button"
            className="care-plan-page__back"
            onClick={() => void navigate(`/dependants/${dependantId}`)}
          >
            ‹ Back
          </button>
          <h1 className="care-plan-page__title">
            Care Plan{dependantQuery.data ? ` - ${dependantQuery.data.fullName}` : ''}
          </h1>
        </div>
        <Button variant="cta-pill" onClick={() => setModalState({ mode: 'create' })}>
          + Add Task
        </Button>
      </div>

      {tasksQuery.isLoading ? <TableSkeleton columns={5} /> : null}
      {tasksQuery.isError ? <p>Failed to load this dependant's care plan.</p> : null}

      {tasksQuery.data ? (
        <TableFrame>
          <table className="ds-table ds-table--table-cell">
            <thead>
              <tr>
                <Th icon={Task01Icon}>Task</Th>
                <Th icon={Tag01Icon}>Category</Th>
                <Th icon={AlertCircleIcon}>Required</Th>
                <Th icon={CheckmarkBadge01Icon}>Status</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {tasksQuery.data.map((task) => (
                <tr key={task.id}>
                  <td>
                    <div className="care-plan-page__task-title">{task.title}</div>
                    {task.description ? (
                      <div className="care-plan-page__task-description">{task.description}</div>
                    ) : null}
                  </td>
                  <td>{task.category ?? '-'}</td>
                  <td>
                    <Badge tone={task.required ? 'success' : 'neutral'}>
                      {task.required ? 'Required' : 'Optional'}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone={task.active ? 'success' : 'neutral'}>
                      {task.active ? 'Active' : 'Retired'}
                    </Badge>
                  </td>
                  <td className="care-plan-page__row-actions">
                    <Button onClick={() => setModalState({ mode: 'edit', task })}>Edit</Button>
                    <Button
                      disabled={toggleActiveMutation.isPending}
                      onClick={() =>
                        toggleActiveMutation.mutate({ taskId: task.id, active: !task.active })
                      }
                    >
                      {task.active ? 'Retire' : 'Reactivate'}
                    </Button>
                  </td>
                </tr>
              ))}
              {tasksQuery.data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="ds-table__empty">
                    No care-plan tasks yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </TableFrame>
      ) : null}

      {toggleActiveMutation.error ? (
        <div className="care-plan-page__error">
          {toggleActiveMutation.error instanceof ApiError
            ? (toggleActiveMutation.error.problem.detail ??
              toggleActiveMutation.error.problem.title)
            : 'Something went wrong.'}
        </div>
      ) : null}

      {modalState ? (
        <CareTaskModal
          dependantId={dependantId!}
          mode={modalState.mode}
          existing={modalState.mode === 'edit' ? modalState.task : undefined}
          onClose={() => setModalState(null)}
        />
      ) : null}
    </div>
  );
}

interface CareTaskModalProps {
  dependantId: string;
  mode: 'create' | 'edit';
  existing?: CareTask;
  onClose: () => void;
}

function CareTaskModal({ dependantId, mode, existing, onClose }: CareTaskModalProps) {
  const { dependants } = useApi();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [category, setCategory] = useState(existing?.category ?? '');
  const [required, setRequired] = useState(existing?.required ?? true);

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        title,
        description: description || undefined,
        category: category || undefined,
        required,
      };
      return mode === 'create'
        ? dependants.createCareTask(dependantId, body)
        : dependants.updateCareTask(dependantId, existing!.id, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dependant', dependantId, 'care-tasks'] });
      onClose();
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <Modal title={mode === 'create' ? 'Add Task' : 'Edit Task'} onClose={onClose}>
      <form className="care-plan-page__modal-form" onSubmit={handleSubmit} autoComplete="off">
        <Input
          id="taskTitle"
          label="Task"
          placeholder="e.g. Assist with bathing"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <div>
          <Label htmlFor="taskDescription">Description</Label>
          <textarea
            id="taskDescription"
            className="ds-input care-plan-page__textarea"
            rows={2}
            placeholder="Any detail the caregiver needs to carry out this task"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <Input
          id="taskCategory"
          label="Category"
          hint="A grouping label only, e.g. Personal care, Household - not a fixed list."
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <Switch
          checked={required}
          onChange={setRequired}
          label="Required"
          hint="A required, active task with no recorded status blocks the caregiver from checking out of a visit."
        />
        {mutation.error ? (
          <div className="care-plan-page__modal-error">
            {mutation.error instanceof ApiError
              ? (mutation.error.problem.detail ?? mutation.error.problem.title)
              : 'Something went wrong.'}
          </div>
        ) : null}
        <div className="care-plan-page__modal-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={mutation.isPending || !title}>
            {mutation.isPending ? 'Saving...' : mode === 'create' ? 'Add' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

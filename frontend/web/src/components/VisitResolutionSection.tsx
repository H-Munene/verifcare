// How a visit's exception was resolved, in its side panel (2026-09-27, the Compliance tab): a
// missed visit, a visit never checked out, or one with a failed check needs a supervisor's
// account of what happened - an outcome and a note. Resolving again adds a newer resolution; the
// earlier ones stay on record (the list below the latest).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  RESOLUTION_OUTCOMES,
  RESOLUTION_OUTCOME_LABELS,
  type ExceptionKind,
  type ResolutionOutcome,
  type VisitResolution,
} from '../api/compliance';
import { useApi } from '../api/useApi';
import { Button } from '../design-system/Button';
import { Label } from '../design-system/Input';
import { dateTime, EXCEPTION_KIND_LABELS } from './compliance/format';
import './VisitResolutionSection.css';

export function VisitResolutionSection({
  visitId,
  exceptionKinds,
  resolutions,
}: {
  visitId: string;
  exceptionKinds: ExceptionKind[];
  /** Newest first. */
  resolutions: VisitResolution[];
}) {
  const { compliance } = useApi();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [outcome, setOutcome] = useState<ResolutionOutcome | ''>('');
  const [note, setNote] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      compliance.resolveVisit(visitId, { outcome: outcome as ResolutionOutcome, note }),
    onSuccess: () => {
      setEditing(false);
      setOutcome('');
      setNote('');
      // The visit's status, its alert and every report that counts it may all have changed.
      for (const key of [
        ['visit-schedule', visitId],
        ['visit-schedules'],
        ['compliance'],
        ['dashboard-overview'],
      ]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });

  const [latest, ...earlier] = resolutions;
  const canSave = outcome !== '' && note.trim() !== '' && !mutation.isPending;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSave) {
      mutation.mutate();
    }
  }

  return (
    <section className="visit-details__section" aria-labelledby="visit-details-resolution">
      <h3 id="visit-details-resolution" className="visit-details__heading">
        Resolution
      </h3>
      <p className="visit-resolution__why">
        {exceptionKinds.map((kind) => EXCEPTION_KIND_LABELS[kind]).join(', ')}
      </p>

      {latest ? (
        <div className="visit-resolution__latest">
          <p className="visit-resolution__outcome">{RESOLUTION_OUTCOME_LABELS[latest.outcome]}</p>
          <p className="visit-resolution__note">{latest.note}</p>
          <p className="visit-resolution__meta">
            {latest.resolvedByName}, {dateTime(latest.resolvedAt)}
          </p>
        </div>
      ) : !editing ? (
        <p className="visit-details__message">Not resolved yet.</p>
      ) : null}

      {editing ? (
        <form className="visit-resolution__form" onSubmit={submit}>
          <div>
            <Label htmlFor="resolutionOutcome" required>
              What happened
            </Label>
            <select
              id="resolutionOutcome"
              className="ds-input visit-resolution__field"
              value={outcome}
              onChange={(event) => setOutcome(event.target.value as ResolutionOutcome)}
              required
            >
              <option value="" disabled>
                Choose an outcome
              </option>
              {RESOLUTION_OUTCOMES.map((value) => (
                <option key={value} value={value}>
                  {RESOLUTION_OUTCOME_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="resolutionNote" required>
              Note
            </Label>
            <textarea
              id="resolutionNote"
              className="ds-input visit-resolution__field visit-resolution__textarea"
              rows={3}
              maxLength={2000}
              placeholder="What you found out, and from whom"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              required
            />
          </div>
          {mutation.error ? (
            <p className="visit-resolution__error" role="alert">
              {mutation.error instanceof ApiError
                ? (mutation.error.problem.detail ?? mutation.error.problem.title)
                : "The resolution couldn't be saved."}
            </p>
          ) : null}
          <div className="visit-resolution__actions">
            <Button
              type="button"
              onClick={() => {
                mutation.reset();
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!canSave}>
              {mutation.isPending ? 'Saving...' : 'Save resolution'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="visit-resolution__actions visit-resolution__actions--start">
          <Button type="button" onClick={() => setEditing(true)}>
            {latest ? 'Add a newer resolution' : 'Resolve'}
          </Button>
        </div>
      )}

      {earlier.length > 0 ? (
        <details className="visit-resolution__history">
          <summary>
            {earlier.length} earlier {earlier.length === 1 ? 'resolution' : 'resolutions'}
          </summary>
          <ul>
            {earlier.map((resolution) => (
              <li key={resolution.id}>
                <strong>{RESOLUTION_OUTCOME_LABELS[resolution.outcome]}</strong>: {resolution.note}
                <span className="visit-resolution__meta">
                  {' '}
                  {resolution.resolvedByName}, {dateTime(resolution.resolvedAt)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

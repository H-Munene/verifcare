// "Needs your attention": late visits that need cover, caregivers waiting at a home for a
// supervisor to start their visit, and missed visits to acknowledge, one category at a time
// behind segmented buttons, the list scrolling within whatever height its container gives it.
// Shared by the
// Overview's panel and the top bar's alerts panel (2026-09-27), so both show the same thing and
// acknowledge the same way.

import {
  CalendarRemove02Icon,
  Clock01Icon,
  Key01Icon,
  UserIcon,
  UserSwitchIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  CheckinOverrideReason,
  DashboardOverview,
  PendingCheckinOverride,
} from '../api/dashboard';
import { useApi } from '../api/useApi';
import { Button } from '../design-system/Button';
import { SegmentedControl, type Segment } from '../design-system/SegmentedControl';
import './AttentionList.css';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

type AttentionCategory = 'cover' | 'overrides' | 'missed';

const OVERRIDE_REASON_LABELS: Record<CheckinOverrideReason, string> = {
  no_family_member_present: 'No family member at the home',
  family_phone_unavailable: "Family member's phone unavailable",
  network_problem: 'Network problem',
  other: 'Other',
};

// A caregiver is at the home with no family member to show a code. A note is required either way,
// so every override records why it was allowed or refused.
function OverrideItem({
  override,
  due,
}: {
  override: PendingCheckinOverride;
  due: (iso: string) => string;
}) {
  const { dashboard } = useApi();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') =>
      dashboard.decideCheckinOverride(override.id, decision, note.trim()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] }),
  });
  const canDecide = note.trim() !== '' && !decide.isPending;
  const noteId = `override-note-${override.id}`;

  return (
    <li className="attention__item attention__override">
      <div className="attention__item-body">
        <p className="attention__title">
          {override.caregiverName} is at {override.dependantName}&rsquo;s home
        </p>
        <p className="attention__meta attention__facts">
          <span>{OVERRIDE_REASON_LABELS[override.reason]}</span>
          <span>
            <HugeiconsIcon icon={Clock01Icon} size={13} strokeWidth={1.8} aria-hidden />
            Asked {due(override.requestedAt)}
          </span>
        </p>
        {override.note ? <p className="attention__meta">{override.note}</p> : null}
        <label className="attention__note-label" htmlFor={noteId}>
          Reason for your decision
        </label>
        <input
          id={noteId}
          className="ds-input"
          value={note}
          maxLength={1000}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="attention__override-actions">
          <Button
            type="button"
            variant="primary"
            disabled={!canDecide}
            onClick={() => decide.mutate('approve')}
          >
            Start visit
          </Button>
          <Button type="button" disabled={!canDecide} onClick={() => decide.mutate('deny')}>
            Decline
          </Button>
          <Link to={`/visits?visit=${override.visitScheduleId}`}>Open visit</Link>
        </div>
      </div>
    </li>
  );
}

// "Needs your attention", one category at a time behind segmented buttons (user request,
// 2026-09-26). It opens on the first category with anything in it.
export function AttentionList({
  attention,
  timeZone,
  appearance = 'segmented',
}: {
  attention: DashboardOverview['attention'];
  timeZone: string;
  /** Segmented buttons on the Overview; tabs in the alerts side panel (user request). */
  appearance?: 'segmented' | 'tabs';
}) {
  const { dashboard } = useApi();
  const queryClient = useQueryClient();
  const acknowledge = useMutation({
    mutationFn: (notificationId: string) => dashboard.acknowledgeAlert(notificationId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] }),
  });
  const acknowledging = acknowledge.isPending ? acknowledge.variables : undefined;
  const onAcknowledge = (notificationId: string) => acknowledge.mutate(notificationId);
  const { missedVisitAlerts, pendingCheckinOverrides, visitsNeedingCover } = attention;
  // Every entry, in a list that scrolls within the panel (user request, 2026-09-26). The server
  // caps each list at 100, so "N more" only appears past that.
  const alerts = missedVisitAlerts.items;
  // Each category's icon is on its segment, not repeated on every entry (user request).
  const segments: Segment[] = [
    {
      id: 'missed',
      label: 'Missed',
      count: missedVisitAlerts.total,
      icon: CalendarRemove02Icon,
      iconColor: 'var(--color-state-no-checkin-icon)',
    },
    {
      id: 'cover',
      label: 'Cover',
      count: visitsNeedingCover.total,
      icon: UserSwitchIcon,
      iconColor: 'var(--color-state-no-checkin-icon)',
    },
    {
      id: 'overrides',
      label: 'Check-ins',
      count: pendingCheckinOverrides.total,
      icon: Key01Icon,
      iconColor: 'var(--color-state-awaiting-icon)',
    },
  ];
  const [chosen, setChosen] = useState<AttentionCategory | null>(null);
  const category = (chosen ??
    segments.find((s) => (s.count ?? 0) > 0)?.id ??
    'missed') as AttentionCategory;
  const due = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    });

  return (
    <div className="attention">
      <SegmentedControl
        segments={segments}
        selected={category}
        onChange={(id) => setChosen(id as AttentionCategory)}
        label="What needs your attention"
        idPrefix="attention"
        appearance={appearance}
      />
      {/* Scrolls within the space under the segments, without growing the panel: the Visit
          outcomes panel beside it sets the row's height, so the bottom stays level. */}
      <div className="attention__viewport">
        <div
          id={`attention-${category}`}
          role="tabpanel"
          aria-labelledby={`attention-tab-${category}`}
          className="attention__panel"
        >
          {category === 'missed' ? (
            missedVisitAlerts.total === 0 ? (
              <p className="attention__empty">No missed visits to acknowledge.</p>
            ) : (
              <ul className="attention__list">
                {alerts.map((alert) => (
                  <li key={alert.id} className="attention__item">
                    <div className="attention__item-body">
                      <p className="attention__title">Missed visit to {alert.dependantName}</p>
                      <p className="attention__meta attention__facts">
                        <span>
                          <HugeiconsIcon icon={UserIcon} size={13} strokeWidth={1.8} aria-hidden />
                          {alert.caregiverName}
                        </span>
                        <span>
                          <HugeiconsIcon
                            icon={Clock01Icon}
                            size={13}
                            strokeWidth={1.8}
                            aria-hidden
                          />
                          Due {due(alert.scheduledStart)}
                        </span>
                      </p>
                      <div className="attention__actions">
                        <Link to={`/visits?visit=${alert.visitScheduleId}`}>Open visit</Link>
                      </div>
                    </div>
                    <Button
                      type="button"
                      className="attention__button"
                      disabled={acknowledging === alert.id}
                      onClick={() => onAcknowledge(alert.id)}
                    >
                      {acknowledging === alert.id ? 'Acknowledging...' : 'Acknowledge'}
                    </Button>
                  </li>
                ))}
                {missedVisitAlerts.total > alerts.length ? (
                  <li className="attention__more">
                    {plural(
                      missedVisitAlerts.total - alerts.length,
                      'more missed visit',
                      'more missed visits',
                    )}{' '}
                    to acknowledge.
                  </li>
                ) : null}
              </ul>
            )
          ) : null}

          {category === 'cover' ? (
            visitsNeedingCover.total === 0 ? (
              <p className="attention__empty">No visits need cover right now.</p>
            ) : (
              <ul className="attention__list">
                {visitsNeedingCover.items.map((item) => (
                  <li key={item.caseId} className="attention__item">
                    <div className="attention__item-body">
                      <p className="attention__title">
                        {item.status === 'exhausted'
                          ? `No cover found for ${item.dependantName}`
                          : `Finding cover for ${item.dependantName}`}
                      </p>
                      <p className="attention__meta attention__facts">
                        <span>
                          <HugeiconsIcon icon={UserIcon} size={13} strokeWidth={1.8} aria-hidden />
                          {item.caregiverName} hasn&rsquo;t arrived
                        </span>
                        <span>
                          <HugeiconsIcon
                            icon={Clock01Icon}
                            size={13}
                            strokeWidth={1.8}
                            aria-hidden
                          />
                          Due {due(item.scheduledStart)}
                        </span>
                      </p>
                      <p className="attention__meta">
                        {item.status === 'exhausted'
                          ? 'Nobody nearby could take it. Arrange this visit yourself.'
                          : item.offeredToName
                            ? `Offered to ${item.offeredToName}.`
                            : 'Looking for someone nearby.'}
                      </p>
                      <div className="attention__actions">
                        <Link to={`/visits?visit=${item.visitScheduleId}`}>Open visit</Link>
                      </div>
                    </div>
                    {item.notificationId ? (
                      <Button
                        type="button"
                        className="attention__button"
                        disabled={acknowledging === item.notificationId}
                        onClick={() => onAcknowledge(item.notificationId!)}
                      >
                        {acknowledging === item.notificationId ? 'Acknowledging...' : 'Acknowledge'}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {category === 'overrides' ? (
            pendingCheckinOverrides.total === 0 ? (
              <p className="attention__empty">No caregivers waiting to start a visit.</p>
            ) : (
              <ul className="attention__list">
                {pendingCheckinOverrides.items.map((override) => (
                  <OverrideItem key={override.id} override={override} due={due} />
                ))}
              </ul>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

// "Needs your attention": missed visits to acknowledge, photos flagged for review, and
// dependants who can't be scheduled without a photo, one category at a time behind segmented
// buttons, the list scrolling within whatever height its container gives it. Shared by the
// Overview's panel and the top bar's alerts panel (2026-09-27), so both show the same thing and
// acknowledge the same way.

import {
  ArrowRight01Icon,
  CalendarRemove02Icon,
  CameraOff02Icon,
  Clock01Icon,
  UserIcon,
  UserSearch01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardOverview } from '../api/dashboard';
import { useApi } from '../api/useApi';
import { Button } from '../design-system/Button';
import { SegmentedControl, type Segment } from '../design-system/SegmentedControl';
import './AttentionList.css';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

type AttentionCategory = 'missed' | 'photos' | 'noPhoto';

// "Needs your attention", one category at a time behind segmented buttons (user request,
// 2026-09-26): missed visits to acknowledge, photos flagged for review, and dependants who can't
// be scheduled without a photo. It opens on the first category with anything in it.
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
  const acknowledgeFailed = acknowledge.isError;
  const onAcknowledge = (notificationId: string) => acknowledge.mutate(notificationId);
  const { missedVisitAlerts, flaggedPhotos, dependantsWithoutPhoto } = attention;
  // Every entry, in a list that scrolls within the panel (user request, 2026-09-26). The server
  // caps each list at 100, so "N more" only appears past that.
  const alerts = missedVisitAlerts.items;
  const withoutPhoto = dependantsWithoutPhoto.items;
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
      id: 'photos',
      label: 'Photos',
      count: flaggedPhotos,
      icon: UserSearch01Icon,
      iconColor: 'var(--color-state-awaiting-icon)',
    },
    {
      id: 'noPhoto',
      label: 'No photo',
      count: dependantsWithoutPhoto.total,
      icon: CameraOff02Icon,
      iconColor: 'var(--color-state-upcoming-icon)',
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
                {acknowledgeFailed ? (
                  <li className="attention__error" role="alert">
                    That alert couldn't be acknowledged. Try again.
                  </li>
                ) : null}
              </ul>
            )
          ) : null}

          {category === 'photos' ? (
            flaggedPhotos === 0 ? (
              <p className="attention__empty">No photos waiting for review.</p>
            ) : (
              <div className="attention__item">
                <div className="attention__item-body">
                  <p className="attention__title">
                    {plural(flaggedPhotos, 'photo looks', 'photos look')} like someone already
                    registered
                  </p>
                  <p className="attention__meta">
                    Check-in can't use {flaggedPhotos === 1 ? 'it' : 'them'} until you review{' '}
                    {flaggedPhotos === 1 ? 'it' : 'them'}.
                  </p>
                  <div className="attention__actions">
                    <Link to="/reviews">Review photos</Link>
                  </div>
                </div>
              </div>
            )
          ) : null}

          {category === 'noPhoto' ? (
            dependantsWithoutPhoto.total === 0 ? (
              <p className="attention__empty">Every active dependant has a photo.</p>
            ) : (
              <>
                <p className="attention__meta attention__intro">
                  Visits can't be scheduled for these dependants until a photo is added.
                </p>
                <ul className="attention__list attention__rows">
                  {withoutPhoto.map((d) => (
                    <li key={d.id}>
                      <Link to={`/dependants/${d.id}`} className="attention__row">
                        {/* The dependant's first initial in a circle, beside their name (user
                            request), so the list reads as people at a glance. */}
                        <span className="attention__avatar" aria-hidden>
                          {d.fullName.trim().charAt(0).toUpperCase() || '?'}
                        </span>
                        <span className="attention__title attention__name">{d.fullName}</span>
                        <HugeiconsIcon
                          icon={ArrowRight01Icon}
                          size={16}
                          strokeWidth={1.8}
                          className="attention__chevron"
                          aria-hidden
                        />
                      </Link>
                    </li>
                  ))}
                  {dependantsWithoutPhoto.total > withoutPhoto.length ? (
                    <li className="attention__more">
                      And {dependantsWithoutPhoto.total - withoutPhoto.length} more.
                    </li>
                  ) : null}
                </ul>
              </>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

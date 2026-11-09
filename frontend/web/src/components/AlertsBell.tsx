// The top bar's alerts bell (2026-09-27, user request: alerts move from the sidebar to a bell that
// opens a side panel with the same content as the Overview's "Needs your attention"). The badge
// counts everything waiting there. It reads the same query as today's Overview, so the two share
// one fetch and never disagree; supervisors only, like the data behind it.

import { Notification03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useApi } from '../api/useApi';
import { SidePanel } from '../design-system/SidePanel';
import { Skeleton, SkeletonRegion } from '../design-system/Skeleton';
import { AttentionList } from './AttentionList';
import { todayInNairobi } from './visitStates';
import './AlertsBell.css';

// Short, because a caregiver can be standing at a home waiting on an override.
const REFRESH_MS = 30_000;

export function AlertsBell() {
  const { dashboard } = useApi();
  // The address the panel was opened on: it counts as open only while we're still there, so a
  // link inside it (e.g. Open visit) navigating away closes it behind.
  const location = useLocation();
  const here = location.pathname + location.search;
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === here;
  const setOpen = (value: boolean) => setOpenedAt(value ? here : null);
  const today = todayInNairobi();
  const query = useQuery({
    queryKey: ['dashboard-overview', today],
    queryFn: () => dashboard.getOverview(today),
    refetchInterval: REFRESH_MS,
  });
  const attention = query.data?.attention;
  const count = attention
    ? attention.missedVisitAlerts.total +
      attention.pendingCheckinOverrides.total +
      attention.visitsNeedingCover.total
    : 0;

  return (
    <>
      <button
        type="button"
        className="alerts-bell"
        aria-label={count > 0 ? `Alerts, ${count} need your attention` : 'Alerts'}
        onClick={() => setOpen(true)}
      >
        <HugeiconsIcon icon={Notification03Icon} size={20} strokeWidth={1.6} aria-hidden />
        {count > 0 ? (
          <span className="alerts-bell__badge" aria-hidden>
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </button>
      {open ? (
        <SidePanel title="Needs your attention" eyebrow="Alerts" onClose={() => setOpen(false)}>
          {attention && query.data ? (
            <AttentionList attention={attention} timeZone={query.data.timeZone} appearance="tabs" />
          ) : query.isError ? (
            <p className="alerts-bell__message">Alerts couldn't be loaded. Try again shortly.</p>
          ) : (
            <SkeletonRegion label="Loading alerts">
              <Skeleton height={36} radius="var(--radius-button)" />
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} height={52} style={{ marginTop: 14 }} />
              ))}
            </SkeletonRegion>
          )}
        </SidePanel>
      ) : null}
    </>
  );
}

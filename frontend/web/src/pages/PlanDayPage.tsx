// Plan a day (2026-11-09): the system groups the day's dependants by area, gives each group to the
// caregiver based closest to it, and proposes an order and times. Nothing reaches anyone's schedule
// until a supervisor has reviewed the plan and published it.

import 'leaflet/dist/leaflet.css';
import { ArrowDown01Icon, ArrowUp01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { latLngBounds } from 'leaflet';
import { useEffect, useState, type FormEvent } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import { useApi } from '../api/useApi';
import type {
  ExcludedReason,
  PlanArrangement,
  PlanCluster,
  UnplacedReason,
  VisitPlan,
} from '../api/visitPlans';
import { todayInNairobi } from '../components/visitStates';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { ConfirmDialog } from '../design-system/ConfirmDialog';
import { Input } from '../design-system/Input';
import './PlanDayPage.css';

// Distinct, dark enough to read on the map's pale tiles and as text on white.
const ROUTE_COLOURS = [
  '#047857',
  '#1d4ed8',
  '#7c3aed',
  '#b45309',
  '#be185d',
  '#0e7490',
  '#475569',
  '#b91c1c',
];

const UNPLACED_LABELS: Record<UnplacedReason, string> = {
  already_scheduled: 'Already has a visit that day',
  no_consent: 'No location consent',
  shift_full: "Doesn't fit in a shift",
};

const EXCLUDED_LABELS: Record<ExcludedReason, string> = {
  already_scheduled: 'Already has visits that day',
  no_consent: 'No location consent',
  no_home_base: 'No home base set',
};

const TIME: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Africa/Nairobi',
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', TIME);
const km = (meters: number) => `${(meters / 1000).toFixed(1)} km`;

function arrangementOf(plan: VisitPlan): PlanArrangement {
  return plan.clusters.map((cluster) => ({
    caregiverId: cluster.caregiverId,
    dependantIds: cluster.stops.map((stop) => stop.dependantId),
  }));
}

function FrameRoutes({ plan }: { plan: VisitPlan }) {
  const map = useMap();
  const points = plan.clusters
    .flatMap((cluster) => cluster.stops)
    .filter((stop) => stop.lat !== null && stop.lng !== null)
    .map((stop) => [stop.lat!, stop.lng!] as [number, number]);
  const key = points.join('|');
  useEffect(() => {
    if (points.length > 0) {
      map.fitBounds(latLngBounds(points), { padding: [32, 32], maxZoom: 15 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands for points
  }, [map, key]);
  return null;
}

function PlanMap({ plan }: { plan: VisitPlan }) {
  return (
    <div className="plan-day__map">
      <MapContainer
        className="plan-day__map-canvas"
        center={[-1.2864, 36.8172]}
        zoom={11}
        aria-label="Map of the planned routes"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FrameRoutes plan={plan} />
        {plan.clusters.map((cluster, c) => {
          const colour = ROUTE_COLOURS[c % ROUTE_COLOURS.length]!;
          const line = cluster.stops
            .filter((stop) => stop.lat !== null && stop.lng !== null)
            .map((stop) => [stop.lat!, stop.lng!] as [number, number]);
          return (
            <div key={cluster.id}>
              <Polyline positions={line} pathOptions={{ color: colour, weight: 3, opacity: 0.6 }} />
              {cluster.stops.map((stop, i) =>
                stop.lat !== null && stop.lng !== null ? (
                  <CircleMarker
                    key={stop.dependantId}
                    center={[stop.lat, stop.lng]}
                    radius={9}
                    pathOptions={{ color: '#ffffff', weight: 2, fillColor: colour, fillOpacity: 1 }}
                  >
                    <Tooltip>
                      {i + 1}. {stop.dependantName}, {clock(stop.scheduledStart)} (
                      {cluster.caregiverName})
                    </Tooltip>
                  </CircleMarker>
                ) : null,
              )}
            </div>
          );
        })}
      </MapContainer>
    </div>
  );
}

function RouteCard({
  cluster,
  colour,
  plan,
  busy,
  onMove,
  onReassign,
}: {
  cluster: PlanCluster;
  colour: string;
  plan: VisitPlan;
  busy: boolean;
  onMove: (index: number, direction: -1 | 1) => void;
  onReassign: (dependantId: string, caregiverId: string) => void;
}) {
  const draft = plan.status === 'draft';
  return (
    <section className="plan-day__route" aria-label={`${cluster.caregiverName}'s route`}>
      <header className="plan-day__route-header">
        <span className="plan-day__swatch" style={{ background: colour }} aria-hidden />
        <h2 className="plan-day__route-name">{cluster.caregiverName}</h2>
        <span className="plan-day__route-meta">
          {cluster.stops.length} {cluster.stops.length === 1 ? 'visit' : 'visits'} ·{' '}
          {km(cluster.totalDistanceMeters)} · {cluster.totalTravelMinutes} min travel
        </span>
      </header>
      {cluster.stops.length === 0 ? (
        <p className="plan-day__empty">No visits in this route.</p>
      ) : (
        <ol className="plan-day__stops">
          {cluster.stops.map((stop, i) => (
            <li key={stop.dependantId} className="plan-day__stop">
              <span className="plan-day__stop-number">{i + 1}</span>
              <div className="plan-day__stop-body">
                <div className="plan-day__stop-name">{stop.dependantName}</div>
                <div className="plan-day__stop-meta">
                  {clock(stop.scheduledStart)} to {clock(stop.scheduledEnd)}
                  {stop.ward ? ` · ${stop.ward}` : ''} · {stop.travelMinutes} min travel
                </div>
              </div>
              {draft ? (
                <div className="plan-day__stop-actions">
                  <button
                    type="button"
                    className="plan-day__icon-button"
                    aria-label={`Move ${stop.dependantName} earlier`}
                    disabled={busy || i === 0}
                    onClick={() => onMove(i, -1)}
                  >
                    <HugeiconsIcon icon={ArrowUp01Icon} size={16} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="plan-day__icon-button"
                    aria-label={`Move ${stop.dependantName} later`}
                    disabled={busy || i === cluster.stops.length - 1}
                    onClick={() => onMove(i, 1)}
                  >
                    <HugeiconsIcon icon={ArrowDown01Icon} size={16} aria-hidden />
                  </button>
                  {plan.clusters.length > 1 ? (
                    <select
                      className="ds-input plan-day__move"
                      aria-label={`Move ${stop.dependantName} to another caregiver`}
                      value=""
                      disabled={busy}
                      onChange={(event) => onReassign(stop.dependantId, event.target.value)}
                    >
                      <option value="">Move to...</option>
                      {plan.clusters
                        .filter((other) => other.caregiverId !== cluster.caregiverId)
                        .map((other) => (
                          <option key={other.caregiverId} value={other.caregiverId}>
                            {other.caregiverName}
                          </option>
                        ))}
                    </select>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function PlanDayPage() {
  const { visitPlans } = useApi();
  const queryClient = useQueryClient();
  const [date, setDate] = useState(todayInNairobi());
  const [shiftStart, setShiftStart] = useState('08:00');
  const [shiftEnd, setShiftEnd] = useState('17:00');
  const [visitMinutes, setVisitMinutes] = useState('45');
  const [confirming, setConfirming] = useState(false);

  const queryKey = ['visit-plans', date];
  const plans = useQuery({ queryKey, queryFn: () => visitPlans.listPlans(date) });
  // The newest plan for the day. A plan id is time-ordered, so the largest is the latest.
  const plan = [...(plans.data?.items ?? [])].sort((a, b) => b.id.localeCompare(a.id))[0];

  const showPlan = (updated: VisitPlan) => {
    queryClient.setQueryData(queryKey, { items: [updated] });
  };
  const create = useMutation({
    mutationFn: () =>
      visitPlans.createPlan({ date, shiftStart, shiftEnd, visitMinutes: Number(visitMinutes) }),
    onSuccess: showPlan,
  });
  const rearrange = useMutation({
    mutationFn: (clusters: PlanArrangement) => visitPlans.rearrange(plan!.id, clusters),
    onSuccess: showPlan,
  });
  const publish = useMutation({
    mutationFn: () => visitPlans.publish(plan!.id),
    onSuccess: (updated) => {
      showPlan(updated);
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ['visit-schedules'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
    },
  });

  const busy = rearrange.isPending || publish.isPending;
  const minutesValid = Number(visitMinutes) >= 15 && Number(visitMinutes) <= 240;
  const canCreate = shiftEnd > shiftStart && minutesValid && !create.isPending;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canCreate) {
      create.mutate();
    }
  }

  function moveWithin(caregiverId: string, index: number, direction: -1 | 1) {
    const next = arrangementOf(plan!);
    const ids = next.find((c) => c.caregiverId === caregiverId)!.dependantIds;
    const [moved] = ids.splice(index, 1);
    ids.splice(index + direction, 0, moved!);
    rearrange.mutate(next);
  }

  function moveToCaregiver(dependantId: string, from: string, to: string) {
    if (!to) {
      return;
    }
    const next = arrangementOf(plan!);
    const source = next.find((c) => c.caregiverId === from)!;
    source.dependantIds = source.dependantIds.filter((id) => id !== dependantId);
    next.find((c) => c.caregiverId === to)!.dependantIds.push(dependantId);
    rearrange.mutate(next);
  }

  const totalVisits = plan?.clusters.reduce((sum, c) => sum + c.stops.length, 0) ?? 0;
  const totalDistance = plan?.clusters.reduce((sum, c) => sum + c.totalDistanceMeters, 0) ?? 0;

  return (
    <div className="plan-day">
      <form className="plan-day__form" onSubmit={submit}>
        <Input
          id="planDate"
          label="Day"
          type="date"
          value={date}
          min={todayInNairobi()}
          onChange={(event) => setDate(event.target.value)}
          required
        />
        <Input
          id="planShiftStart"
          label="Shift starts"
          type="time"
          value={shiftStart}
          onChange={(event) => setShiftStart(event.target.value)}
          required
        />
        <Input
          id="planShiftEnd"
          label="Shift ends"
          type="time"
          value={shiftEnd}
          onChange={(event) => setShiftEnd(event.target.value)}
          required
        />
        <Input
          id="planVisitMinutes"
          label="Visit length (minutes)"
          type="number"
          min={15}
          max={240}
          step={5}
          value={visitMinutes}
          onChange={(event) => setVisitMinutes(event.target.value)}
          required
        />
        <Button type="submit" variant="primary" disabled={!canCreate}>
          {create.isPending ? 'Planning...' : plan ? 'Make a new plan' : 'Make a plan'}
        </Button>
      </form>

      {!plan && plans.isSuccess ? (
        <p className="plan-day__intro">
          Nothing is planned for this day yet. Making a plan groups dependants by area and proposes
          each caregiver&rsquo;s order and times. Nothing changes until you publish it.
        </p>
      ) : null}

      {plan ? (
        <>
          <div className="plan-day__summary">
            <Badge tone={plan.status === 'published' ? 'success' : 'neutral'}>
              {plan.status === 'published' ? 'Published' : 'Draft'}
            </Badge>
            <span>
              {totalVisits} {totalVisits === 1 ? 'visit' : 'visits'} · {plan.clusters.length}{' '}
              {plan.clusters.length === 1 ? 'caregiver' : 'caregivers'} · {km(totalDistance)}{' '}
              estimated travel
            </span>
            {plan.status === 'draft' ? (
              <Button
                type="button"
                variant="primary"
                disabled={busy || totalVisits === 0}
                onClick={() => {
                  publish.reset();
                  setConfirming(true);
                }}
              >
                Publish plan
              </Button>
            ) : null}
          </div>

          <div className="plan-day__layout">
            <div className="plan-day__routes">
              {plan.clusters.map((cluster, c) => (
                <RouteCard
                  key={cluster.id}
                  cluster={cluster}
                  colour={ROUTE_COLOURS[c % ROUTE_COLOURS.length]!}
                  plan={plan}
                  busy={busy}
                  onMove={(index, direction) => moveWithin(cluster.caregiverId, index, direction)}
                  onReassign={(dependantId, to) =>
                    moveToCaregiver(dependantId, cluster.caregiverId, to)
                  }
                />
              ))}
              {plan.clusters.length === 0 ? (
                <p className="plan-day__empty">
                  No routes could be made. The lists below explain who couldn&rsquo;t be included.
                </p>
              ) : null}
              {plan.unplaced.length > 0 ? (
                <section className="plan-day__notes" aria-label="Dependants not in this plan">
                  <h2 className="plan-day__notes-title">Not in this plan</h2>
                  <ul>
                    {plan.unplaced.map((entry) => (
                      <li key={entry.dependantId}>
                        {entry.dependantName}: {UNPLACED_LABELS[entry.reason]}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {plan.excludedCaregivers.length > 0 ? (
                <section className="plan-day__notes" aria-label="Caregivers not in this plan">
                  <h2 className="plan-day__notes-title">Caregivers left out</h2>
                  <ul>
                    {plan.excludedCaregivers.map((entry) => (
                      <li key={entry.caregiverId}>
                        {entry.caregiverName}: {EXCLUDED_LABELS[entry.reason]}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <p className="plan-day__footnote">
                Travel times are estimates from straight-line distance. Check them against what you
                know of the area before publishing.
              </p>
            </div>
            <PlanMap plan={plan} />
          </div>
        </>
      ) : null}

      {confirming && plan ? (
        <ConfirmDialog
          title="Publish this plan?"
          message={`This creates ${totalVisits} ${totalVisits === 1 ? 'visit' : 'visits'} and they will appear in caregivers' and families' apps.`}
          confirmLabel="Publish"
          pending={publish.isPending}
          pendingLabel="Publishing..."
          onConfirm={() => publish.mutate()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}

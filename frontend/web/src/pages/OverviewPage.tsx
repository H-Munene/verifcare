// The supervisor console's landing page (2026-09-26, user request): one day of visits at a glance -
// four status tiles that double as the map's legend and filter, the map of homes with the day's
// visit list beside it, the last 14 days' outcomes, and what needs a supervisor's attention. The
// day comes from ?date= so a reload or a shared link keeps it; it defaults to today in Nairobi,
// the backend's own day, and today's view refreshes every minute because visit states move with
// the clock.

import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { DashboardOverview, OverviewVisit, VisitState } from '../api/dashboard';
import { useApi } from '../api/useApi';
import { AttentionList } from '../components/AttentionList';
import { OsmVisitsMap } from '../components/OsmVisitsMap';
import { OutcomeSummary } from '../components/OutcomeSummary';
import { OutcomeTrendChart } from '../components/OutcomeTrendChart';
import { VisitsMap } from '../components/VisitsMap';
import { STATE_META, VISIT_STATES, formatTime, todayInNairobi } from '../components/visitStates';
import { Button } from '../design-system/Button';
import './OverviewPage.css';

const TIME_ZONE = 'Africa/Nairobi';
const USE_GOOGLE_MAP = import.meta.env.VITE_OVERVIEW_MAP === 'google';
const REFRESH_MS = 60_000;

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function longDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The small line under each tile's count: the fact a supervisor would look for next. */
function tileDetail(state: VisitState, visits: OverviewVisit[], overview: DashboardOverview) {
  const time = (iso: string) => formatTime(iso, overview.timeZone);
  switch (state) {
    case 'upcoming':
      return visits[0] ? `Next at ${time(visits[0].scheduledStart)}` : 'None still to start';
    case 'awaiting_checkin': {
      if (!visits[0]) {
        return 'Nobody waiting';
      }
      const waited = Math.round(
        (Date.parse(overview.generatedAt) - Date.parse(visits[0].scheduledStart)) / 60_000,
      );
      return `Longest wait ${waited < 60 ? `${waited} min` : `${Math.floor(waited / 60)} h ${waited % 60} min`}`;
    }
    case 'checked_in': {
      const out = visits.filter((v) => v.checkoutAt).length;
      return visits.length === 0 ? 'None yet' : `${out} checked out`;
    }
    case 'no_checkin':
      return 'Ended with no check-in';
  }
}

export function OverviewPage() {
  const { dashboard } = useApi();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const todayDate = todayInNairobi();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('date') ?? '')
    ? searchParams.get('date')!
    : todayDate;
  const isToday = date === todayDate;
  const [focusState, setFocusState] = useState<VisitState | null>(null);
  const [activeHome, setActiveHome] = useState<string | null>(null);

  const overviewQuery = useQuery({
    queryKey: ['dashboard-overview', date],
    queryFn: () => dashboard.getOverview(date),
    refetchInterval: isToday ? REFRESH_MS : false,
    // Keep the last day on screen while the next loads, rather than blanking the whole page.
    placeholderData: keepPreviousData,
  });

  function showDate(next: string) {
    setFocusState(null);
    setActiveHome(null);
    setSearchParams(next === todayDate ? {} : { date: next });
  }

  const overview = overviewQuery.data;
  const header = (
    <header className="overview__header">
      <div>
        <h1 className="overview__title">Overview</h1>
        <p className="overview__subtitle">
          {longDate(date)}
          {isToday ? ', today' : ''}. Times are Nairobi time.
          {overview && isToday ? ` Updated ${formatTime(overview.generatedAt, TIME_ZONE)}.` : ''}
        </p>
      </div>
      <div className="overview__date-controls">
        <Button
          type="button"
          aria-label="Previous day"
          onClick={() => showDate(shiftDate(date, -1))}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} aria-hidden />
        </Button>
        <input
          type="date"
          className="overview__date-input"
          aria-label="Day to show"
          value={date}
          onChange={(event) => {
            if (event.target.value) {
              showDate(event.target.value);
            }
          }}
        />
        <Button type="button" aria-label="Next day" onClick={() => showDate(shiftDate(date, 1))}>
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={1.5} aria-hidden />
        </Button>
        <Button type="button" disabled={isToday} onClick={() => showDate(todayDate)}>
          Today
        </Button>
      </div>
    </header>
  );

  if (!overview) {
    return (
      <div className="overview">
        {header}
        <div className="overview__message">
          {overviewQuery.isError ? (
            <>
              <p>The overview couldn't be loaded. Check your connection and try again.</p>
              <Button type="button" onClick={() => void overviewQuery.refetch()}>
                Try again
              </Button>
            </>
          ) : (
            <p>Loading the overview...</p>
          )}
        </div>
      </div>
    );
  }

  const byState = Object.fromEntries(
    VISIT_STATES.map((state) => [state, overview.visits.filter((v) => v.state === state)]),
  ) as Record<VisitState, OverviewVisit[]>;
  const shownVisits = focusState ? byState[focusState] : overview.visits;
  const { attention } = overview;

  return (
    <div className="overview">
      {header}

      <div className="overview__grid">
        <div
          className="overview__tiles"
          role="group"
          aria-label="Visits by status. Choose one to show only those visits."
        >
          {VISIT_STATES.map((state) => {
            const pressed = focusState === state;
            return (
              <button
                key={state}
                type="button"
                className={[
                  'overview__tile',
                  pressed ? 'overview__tile--pressed' : '',
                  focusState && !pressed ? 'overview__tile--dimmed' : '',
                ].join(' ')}
                aria-pressed={pressed}
                onClick={() => setFocusState(pressed ? null : state)}
              >
                <span className="overview__tile-label">
                  <span
                    className="overview__state-dot"
                    style={{ background: STATE_META[state].color }}
                    aria-hidden
                  />
                  {STATE_META[state].label}
                </span>
                <span className="overview__tile-count">{byState[state].length}</span>
                <span className="overview__tile-detail">
                  {tileDetail(state, byState[state], overview)}
                </span>
              </button>
            );
          })}
        </div>

        <section className="overview__map" aria-labelledby="overview-map">
          {/* Same height as the visit list's header, and both have an edge-to-edge line under
              them, so the line under "Map" and the one under "All visits" read as one. */}
          <div className="overview__section-head">
            <h2 id="overview-map" className="overview__panel-title">
              Map
            </h2>
          </div>
          <div className="overview__map-frame">
            {/* OpenStreetMap by default (the user's experiment, 2026-09-26);
                VITE_OVERVIEW_MAP=google switches back to Google Maps. */}
            {USE_GOOGLE_MAP ? (
              <VisitsMap
                apiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY}
                visits={shownVisits}
                timeZone={overview.timeZone}
                activeId={activeHome}
                onActiveChange={setActiveHome}
              />
            ) : (
              <OsmVisitsMap
                visits={shownVisits}
                timeZone={overview.timeZone}
                activeId={activeHome}
                onActiveChange={setActiveHome}
              />
            )}
          </div>
        </section>

        <section className="overview__panel overview__visits" aria-labelledby="overview-visits">
          <div className="overview__section-head">
            <h2 id="overview-visits" className="overview__panel-title">
              {focusState ? STATE_META[focusState].label : 'All visits'}
            </h2>
            <span className="overview__panel-count">{shownVisits.length}</span>
            {focusState ? (
              <button
                type="button"
                className="overview__text-button"
                onClick={() => setFocusState(null)}
              >
                Show all
              </button>
            ) : null}
          </div>
          {shownVisits.length === 0 ? (
            <p className="overview__empty">
              {overview.visits.length === 0
                ? 'No visits are scheduled for this day.'
                : 'No visits in this status.'}
            </p>
          ) : (
            <ul className="overview__visit-list">
              {shownVisits.map((visit) => (
                <li key={visit.id}>
                  <button
                    type="button"
                    className={[
                      'overview__visit',
                      activeHome === visit.dependant.id ? 'overview__visit--active' : '',
                    ].join(' ')}
                    onMouseEnter={() => setActiveHome(visit.dependant.id)}
                    onMouseLeave={() => setActiveHome(null)}
                    onFocus={() => setActiveHome(visit.dependant.id)}
                    onBlur={() => setActiveHome(null)}
                    onClick={() => void navigate(`/visits/${visit.id}`)}
                  >
                    <span className="overview__visit-time">
                      {formatTime(visit.scheduledStart, overview.timeZone)}
                    </span>
                    <span className="overview__visit-names">
                      <span className="overview__visit-dependant">{visit.dependant.fullName}</span>
                      <span className="overview__visit-caregiver">{visit.caregiver.fullName}</span>
                    </span>
                    <span className="overview__visit-state">
                      <span
                        className="overview__state-dot"
                        style={{ background: STATE_META[visit.state].color }}
                        aria-hidden
                      />
                      {STATE_META[visit.state].label}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="overview__panel overview__trend" aria-labelledby="overview-trend">
          <div className="overview__section-head">
            <h2 id="overview-trend" className="overview__panel-title">
              Visit outcomes
            </h2>
          </div>
          {/* The summary card (rate, meter, the outcomes explained, which is also the chart's
              legend) beside the 14-day chart; they stack when the panel is narrow. */}
          <div className="overview__panel-body overview__outcomes">
            <div className="overview__outcomes-summary">
              <OutcomeSummary overview={overview} />
            </div>
            <div className="overview__outcomes-chart">
              <OutcomeTrendChart
                days={overview.trend}
                selectedDate={date}
                onSelectDate={showDate}
              />
            </div>
          </div>
          {/* A line across the whole panel under the card and the chart (user request,
              2026-09-26), then when the numbers were fetched and where the visits are. */}
          <div className="overview__panel-foot">
            <span>Updated {formatTime(overview.generatedAt, overview.timeZone)}</span>
            <Link to="/visits" className="overview__foot-link">
              View visits
              <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} aria-hidden />
            </Link>
          </div>
        </section>

        <section
          className="overview__panel overview__attention"
          aria-labelledby="overview-attention"
        >
          <div className="overview__section-head">
            <h2 id="overview-attention" className="overview__panel-title">
              Needs your attention
            </h2>
          </div>
          <div className="overview__panel-body overview__attention-body">
            <AttentionList attention={attention} timeZone={overview.timeZone} />
          </div>
        </section>
      </div>
    </div>
  );
}

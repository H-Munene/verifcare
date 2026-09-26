// The Overview's visit-outcomes card, styled on the user's inspiration
// (temp_images/visit_outcomes_inpiration_ui.png, 2026-09-26): the completion rate as a big number
// with its change against the previous 14 days, the same percentage as a row of thin bars, three
// supporting numbers, then each outcome with what it means and its count - which is also the
// chart's legend - and when it was updated.
//
// The completion rate is completed / (completed + missed): open and cancelled visits haven't had
// the chance to succeed or fail, so they don't count either way.

import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link } from 'react-router-dom';
import type { DashboardOverview } from '../api/dashboard';
import { OUTCOME_SERIES, dayLabel } from './outcomeSeries';
import { formatTime } from './visitStates';
import './OutcomeSummary.css';

const TICKS = 40;

function rateOf(completed: number, missed: number): number | null {
  const decided = completed + missed;
  return decided === 0 ? null : (completed / decided) * 100;
}

export function OutcomeSummary({ overview }: { overview: DashboardOverview }) {
  const { trend, previousPeriod } = overview;
  const totals = Object.fromEntries(
    OUTCOME_SERIES.map((s) => [s.key, trend.reduce((n, d) => n + d[s.key], 0)]),
  ) as Record<(typeof OUTCOME_SERIES)[number]['key'], number>;
  const rate = rateOf(totals.completed, totals.missed);
  const previousRate = rateOf(previousPeriod.completed, previousPeriod.missed);
  const change = rate !== null && previousRate !== null ? Math.round(rate - previousRate) : null;
  const allVisits = Object.values(totals).reduce((a, b) => a + b, 0);
  const perDay = allVisits / trend.length;
  const filled = rate === null ? 0 : Math.round((rate / 100) * TICKS);
  const range = `${dayLabel(trend[0]!.date, { day: 'numeric', month: 'short' })} to ${dayLabel(
    trend.at(-1)!.date,
    { day: 'numeric', month: 'short' },
  )}`;

  return (
    <div className="outcome-summary">
      <div className="outcome-summary__card">
        <p className="outcome-summary__label">Completion rate</p>
        <div className="outcome-summary__headline">
          <span className="outcome-summary__rate">
            {rate === null ? '-' : `${Math.round(rate)}%`}
          </span>
          {change !== null ? (
            <span
              className={[
                'outcome-summary__change',
                change < 0 ? 'outcome-summary__change--down' : '',
              ].join(' ')}
              title="Change from the previous 14 days"
            >
              {change > 0 ? '+' : change < 0 ? '−' : '±'}
              {Math.abs(change)} pts
              <span className="outcome-summary__sr-only"> from the previous 14 days</span>
            </span>
          ) : null}
        </div>

        {/* The same percentage as a row of thin bars, filled from the left. */}
        <div
          className="outcome-summary__ticks"
          role="img"
          aria-label={
            rate === null
              ? 'No finished visits yet'
              : `${Math.round(rate)}% of finished visits completed`
          }
        >
          {Array.from({ length: TICKS }, (_, i) => (
            <span
              key={i}
              className={
                i < filled
                  ? 'outcome-summary__tick outcome-summary__tick--on'
                  : 'outcome-summary__tick'
              }
            />
          ))}
        </div>
        <p className="outcome-summary__caption">
          {rate === null
            ? `No visits finished between ${range} yet.`
            : `Of the visits that finished between ${range}, the share that were completed rather than missed.`}
        </p>

        <dl className="outcome-summary__stats">
          <div>
            <dt>Completed</dt>
            <dd>{totals.completed}</dd>
          </div>
          <div>
            <dt>Missed</dt>
            <dd>{totals.missed}</dd>
          </div>
          <div>
            <dt>Visits a day</dt>
            <dd>{perDay.toFixed(perDay < 10 ? 1 : 0)}</dd>
          </div>
        </dl>
      </div>

      <ul className="outcome-summary__outcomes">
        {OUTCOME_SERIES.map((s) => (
          <li key={s.key} className="outcome-summary__outcome">
            <span className="outcome-summary__swatch" style={{ background: s.color }} aria-hidden />
            <HugeiconsIcon
              icon={s.icon}
              size={16}
              strokeWidth={1.6}
              className="outcome-summary__outcome-icon"
              aria-hidden
            />
            <span className="outcome-summary__outcome-text">
              <span className="outcome-summary__outcome-label">{s.label}</span>
              <span className="outcome-summary__outcome-explanation">{s.explanation}</span>
            </span>
            <span className={`outcome-summary__count outcome-summary__count--${s.key}`}>
              {totals[s.key]}
            </span>
          </li>
        ))}
      </ul>

      <div className="outcome-summary__footer">
        <span>Updated {formatTime(overview.generatedAt, overview.timeZone)}</span>
        <Link to="/visits" className="outcome-summary__link">
          View visits
          <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} aria-hidden />
        </Link>
      </div>
    </div>
  );
}

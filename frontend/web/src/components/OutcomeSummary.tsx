// The Overview's visit-outcomes card, styled on the user's inspiration
// (temp_images/visit_outcomes_inpiration_ui.png, 2026-09-26): the completion rate as a big number
// with its change against the previous 14 days, the same percentage as a row of thin bars, three
// supporting numbers. (The per-outcome list below it was removed at the
// user's request, 2026-09-26; the chart carries its own legend instead.)
//
// The completion rate is completed / (completed + missed): open and cancelled visits haven't had
// the chance to succeed or fail, so they don't count either way.

import type { DashboardOverview } from '../api/dashboard';
import { OUTCOME_SERIES, dayLabel } from './outcomeSeries';
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
  const previousRate = previousPeriod
    ? rateOf(previousPeriod.completed, previousPeriod.missed)
    : null;
  const change = rate !== null && previousRate !== null ? Math.round(rate - previousRate) : null;
  const allVisits = Object.values(totals).reduce((a, b) => a + b, 0);
  const perDay = allVisits / trend.length;
  const filled = rate === null ? 0 : Math.round((rate / 100) * TICKS);
  const finished = totals.completed + totals.missed;
  const shareOfFinished = (n: number) =>
    finished === 0 ? '-' : `${Math.round((n / finished) * 100)}%`;
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
              <span className="sr-only"> from the previous 14 days</span>
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

        {/* Each figure with its share beneath it (user request, 2026-09-26). Completed and
            missed are shares of the finished visits, so they add up to 100% and completed matches
            the rate above; a day's average has no share, so it shows the 14-day total. */}
        <dl className="outcome-summary__stats">
          <div>
            <dt>Completed</dt>
            <dd>
              {totals.completed}
              <span className="outcome-summary__share">{shareOfFinished(totals.completed)}</span>
            </dd>
          </div>
          <div>
            <dt>Missed</dt>
            <dd>
              {totals.missed}
              <span className="outcome-summary__share">{shareOfFinished(totals.missed)}</span>
            </dd>
          </div>
          <div>
            <dt>Visits a day</dt>
            <dd>
              {perDay.toFixed(perDay < 10 ? 1 : 0)}
              <span className="outcome-summary__share">{allVisits} in total</span>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

// The Overview's 14-day visit outcomes (2026-09-26, user request): one stacked column per day -
// completed, missed, still open, cancelled - headed by the completion rate, the one number that
// says whether care is being delivered. Completed sits on the baseline so the reliable part of
// each day is easy to compare, and missed sits directly on it where a gap is hardest to miss.
// Every column is a button with a hover/focus summary that moves the rest of the page to that day;
// the same numbers are also in a table for screen readers.

import { useState } from 'react';
import type { TrendDay } from '../api/dashboard';
import './OutcomeTrendChart.css';

const SERIES = [
  { key: 'completed', label: 'Completed', color: 'var(--color-state-checked-in)' },
  { key: 'missed', label: 'Missed', color: 'var(--color-state-no-checkin)' },
  { key: 'open', label: 'Not finished yet', color: 'var(--color-state-upcoming)' },
  { key: 'cancelled', label: 'Cancelled', color: 'var(--color-state-cancelled)' },
] as const;

function total(day: TrendDay): number {
  return day.completed + day.missed + day.open + day.cancelled;
}

/** A clean axis top: the next number up that divides into 4 whole steps. */
function niceMax(value: number): number {
  if (value <= 4) {
    return 4;
  }
  const step = Math.ceil(value / 4);
  return step * 4;
}

function describeDay(day: TrendDay): string {
  const parts = SERIES.filter((s) => day[s.key] > 0).map(
    (s) => `${day[s.key]} ${s.label.toLowerCase()}`,
  );
  return `${dayLabel(day.date, { weekday: 'long', day: 'numeric', month: 'long' })}: ${
    parts.length > 0 ? parts.join(', ') : 'no visits'
  }. Show this day.`;
}

function dayLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  // Noon UTC keeps the calendar date the same in every time zone.
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    ...options,
    timeZone: 'UTC',
  });
}

export interface OutcomeTrendChartProps {
  days: TrendDay[];
  selectedDate: string;
  onSelectDate: (date: string) => void;
}

export function OutcomeTrendChart({ days, selectedDate, onSelectDate }: OutcomeTrendChartProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const completed = days.reduce((n, d) => n + d.completed, 0);
  const missed = days.reduce((n, d) => n + d.missed, 0);
  const decided = completed + missed;
  const rate = decided > 0 ? Math.round((completed / decided) * 100) : null;
  const max = niceMax(Math.max(0, ...days.map(total)));
  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const range = `${dayLabel(days[0]!.date, { day: 'numeric', month: 'short' })} to ${dayLabel(
    days.at(-1)!.date,
    { day: 'numeric', month: 'short' },
  )}`;

  return (
    <div className="trend">
      <div className="trend__summary">
        {rate === null ? (
          <p className="trend__rate-empty">No visits finished in these 14 days yet.</p>
        ) : (
          <>
            <span className="trend__rate">{rate}%</span>
            <p className="trend__rate-caption">
              of finished visits were completed, {range}. {completed} completed, {missed} missed.
            </p>
          </>
        )}
      </div>

      <ul className="trend__legend">
        {SERIES.map((s) => (
          <li key={s.key}>
            <span className="trend__swatch" style={{ background: s.color }} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>

      <div className="trend__plot">
        <div className="trend__grid" aria-hidden>
          {ticks.map((tick) => (
            <div
              key={tick}
              className="trend__gridline"
              style={{ bottom: `${(tick / max) * 100}%` }}
            >
              <span className="trend__tick">{tick}</span>
            </div>
          ))}
        </div>
        <div className="trend__columns">
          {days.map((day) => {
            const isHovered = hovered === day.date;
            const dayTotal = total(day);
            return (
              <button
                key={day.date}
                type="button"
                aria-label={describeDay(day)}
                aria-pressed={day.date === selectedDate}
                className={[
                  'trend__slot',
                  day.date === selectedDate ? 'trend__slot--selected' : '',
                  isHovered ? 'trend__slot--hovered' : '',
                ].join(' ')}
                onMouseEnter={() => setHovered(day.date)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(day.date)}
                onBlur={() => setHovered(null)}
                onClick={() => onSelectDate(day.date)}
              >
                <span className="trend__bar" style={{ height: `${(dayTotal / max) * 100}%` }}>
                  {SERIES.map((s) =>
                    day[s.key] > 0 ? (
                      <span
                        key={s.key}
                        className="trend__segment"
                        style={{ flexGrow: day[s.key], background: s.color }}
                      />
                    ) : null,
                  )}
                </span>
                {isHovered ? <DayTooltip day={day} /> : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="trend__axis" aria-hidden>
        {days.map((day) => (
          <span
            key={day.date}
            className={day.date === selectedDate ? 'trend__axis-label--selected' : undefined}
          >
            <span className="trend__weekday">{dayLabel(day.date, { weekday: 'narrow' })}</span>
            {dayLabel(day.date, { day: 'numeric' })}
          </span>
        ))}
      </div>

      {/* The chart's numbers as a table, for screen readers. */}
      <table className="trend__table">
        <caption>Visit outcomes per day, {range}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {SERIES.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.date}>
              <th scope="row">
                {dayLabel(day.date, { weekday: 'long', day: 'numeric', month: 'long' })}
              </th>
              {SERIES.map((s) => (
                <td key={s.key}>{day[s.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayTooltip({ day }: { day: TrendDay }) {
  return (
    <span className="trend__tooltip" aria-hidden>
      <span className="trend__tooltip-date">
        {dayLabel(day.date, { weekday: 'long', day: 'numeric', month: 'short' })}
      </span>
      {total(day) === 0 ? (
        <span className="trend__tooltip-row">No visits</span>
      ) : (
        SERIES.map((s) =>
          day[s.key] > 0 ? (
            <span key={s.key} className="trend__tooltip-row">
              <span className="trend__swatch" style={{ background: s.color }} />
              <span className="trend__tooltip-label">{s.label}</span>
              <span className="trend__tooltip-value">{day[s.key]}</span>
            </span>
          ) : null,
        )
      )}
    </span>
  );
}

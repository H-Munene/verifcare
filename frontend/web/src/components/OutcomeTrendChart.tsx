// The Overview's 14-day visit outcomes as a 100% stacked column chart, styled on the user's
// inspiration (temp_images/stacked_bar_chart.PNG, 2026-09-26): full-height columns with sharp
// corners split by each outcome's share, a dashed line on the selected day, the pointed-at day's
// date top left and "100%" top right, the first and last dates underneath. Shares rather than
// counts, so a quiet weekend and a busy weekday compare fairly; the counts are in each column's
// summary. Completed sits on the baseline, missed directly on it, where a bad day stands out.
//
// Every column is a button with a hover/focus summary that moves the page to that day; the same
// numbers are also in a table for screen readers.

import { useState } from 'react';
import type { TrendDay } from '../api/dashboard';
import { OUTCOME_SERIES, dayLabel, dayTotal } from './outcomeSeries';
import './OutcomeTrendChart.css';

function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

function describeDay(day: TrendDay): string {
  const total = dayTotal(day);
  const parts = OUTCOME_SERIES.filter((s) => day[s.key] > 0).map(
    (s) => `${day[s.key]} ${s.label.toLowerCase()} (${percent(day[s.key], total)}%)`,
  );
  return `${dayLabel(day.date, { weekday: 'long', day: 'numeric', month: 'long' })}: ${
    parts.length > 0 ? parts.join(', ') : 'no visits'
  }. Show this day.`;
}

export interface OutcomeTrendChartProps {
  days: TrendDay[];
  selectedDate: string;
  onSelectDate: (date: string) => void;
}

export function OutcomeTrendChart({ days, selectedDate, onSelectDate }: OutcomeTrendChartProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const shortDate = (date: string) => dayLabel(date, { month: 'short', day: 'numeric' });
  const first = days[0]!.date;
  const last = days.at(-1)!.date;

  return (
    <div className="trend">
      <ul className="trend__legend">
        {OUTCOME_SERIES.map((s) => (
          <li key={s.key}>
            <span className="trend__swatch" style={{ background: s.color }} aria-hidden />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="trend__labels">
        <span className="trend__focus-date">{shortDate(hovered ?? selectedDate)}</span>
        <span>100%</span>
      </div>

      <div className="trend__plot">
        {days.map((day) => {
          const total = dayTotal(day);
          const selected = day.date === selectedDate;
          return (
            <button
              key={day.date}
              type="button"
              className={[
                'trend__column',
                selected ? 'trend__column--selected' : '',
                hovered === day.date ? 'trend__column--hovered' : '',
              ].join(' ')}
              aria-label={describeDay(day)}
              aria-pressed={selected}
              onMouseEnter={() => setHovered(day.date)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(day.date)}
              onBlur={() => setHovered(null)}
              onClick={() => onSelectDate(day.date)}
            >
              <span className={total === 0 ? 'trend__bar trend__bar--empty' : 'trend__bar'}>
                {OUTCOME_SERIES.map((s) =>
                  day[s.key] > 0 ? (
                    <span
                      key={s.key}
                      className="trend__segment"
                      style={{ flexGrow: day[s.key], background: s.color }}
                    />
                  ) : null,
                )}
              </span>
              {selected ? <span className="trend__marker" aria-hidden /> : null}
              {hovered === day.date ? <DayTooltip day={day} /> : null}
            </button>
          );
        })}
      </div>

      <div className="trend__labels trend__labels--bottom" aria-hidden>
        <span>{shortDate(first)}</span>
        <span>{shortDate(last)}</span>
      </div>

      {/* The chart's numbers as a table, for screen readers. */}
      <table className="trend__table">
        <caption>
          Visit outcomes per day, {shortDate(first)} to {shortDate(last)}
        </caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {OUTCOME_SERIES.map((s) => (
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
              {OUTCOME_SERIES.map((s) => (
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
  const total = dayTotal(day);
  return (
    <span className="trend__tooltip" aria-hidden>
      <span className="trend__tooltip-date">
        {dayLabel(day.date, { weekday: 'long', day: 'numeric', month: 'short' })}
      </span>
      {total === 0 ? (
        <span className="trend__tooltip-row">No visits</span>
      ) : (
        OUTCOME_SERIES.map((s) =>
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

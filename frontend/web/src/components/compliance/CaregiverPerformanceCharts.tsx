// Caregiver performance as charts (2026-11-24), the same month's numbers as the table, shown when the
// supervisor presses "Show charts". Three views, each answering one question: who missed visits and
// were they excused; how complete and punctual each caregiver was; and whether visits improved week
// by week. Still no overall score (see CaregiverPerformanceReport.tsx). Plain HTML and CSS bars, like
// OutcomeTrendChart.tsx, with every value also written as text, and each chart's numbers in a table
// for screen readers.
//
// The whole team reads best as horizontal bars, one row per caregiver. When the supervisor has
// searched for particular caregivers, the few that remain are drawn as vertical bars instead, so
// each person's numbers are larger and easier to compare side by side.

import type { ReactNode } from 'react';
import type { CaregiverPerformanceRow, Period } from '../../api/compliance';
import { percent } from './format';
import { weekRange } from './period';
import './CaregiverPerformanceCharts.css';

export type ChartLayout = 'horizontal' | 'vertical';

const OUTCOMES = [
  { key: 'completed', label: 'Completed', color: 'var(--color-state-checked-in)' },
  { key: 'missed', label: 'Missed', color: 'var(--color-state-no-checkin)' },
  { key: 'excused', label: 'Excused', color: 'var(--color-state-upcoming)' },
] as const;

interface RateSeries {
  label: string;
  color: string;
  value: (row: CaregiverPerformanceRow) => number | null;
}

const PUNCTUALITY: [RateSeries, RateSeries] = [
  { label: 'Completion', color: 'var(--color-accent)', value: (r) => r.completionRate },
  { label: 'On time', color: 'var(--color-state-awaiting)', value: (r) => r.onTimeRate },
];

interface TipItem {
  label: string;
  color: string;
  value: number;
}

const outcomeItems = (row: CaregiverPerformanceRow): TipItem[] =>
  OUTCOMES.map((o) => ({ label: o.label, color: o.color, value: row[o.key] }));

// The counts behind a bar, shown while the pointer is over it (CSS :hover on the row or column).
// Keyboard and screen reader users get the same numbers from each chart's table, or the Show table
// view.
function Tooltip({ title, items }: { title: string; items: TipItem[] }) {
  return (
    <span className="perf-charts__tip">
      <span className="perf-charts__tip-title">{title}</span>
      {items.map((item) => (
        <span key={item.label} className="perf-charts__tip-row">
          <span className="perf-charts__swatch" style={{ background: item.color }} />
          <span className="perf-charts__tip-label">{item.label}</span>
          <span className="perf-charts__tip-value">{item.value}</span>
        </span>
      ))}
    </span>
  );
}

function Legend({ items }: { items: readonly { label: string; color: string }[] }) {
  return (
    <ul className="perf-charts__legend">
      {items.map((item) => (
        <li key={item.label}>
          <span className="perf-charts__swatch" style={{ background: item.color }} aria-hidden />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function Chart({
  title,
  hint,
  wide,
  children,
}: {
  title: string;
  hint: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={wide ? 'perf-charts__card perf-charts__card--wide' : 'perf-charts__card'}>
      <h3 className="perf-charts__title">{title}</h3>
      <p className="perf-charts__hint">{hint}</p>
      {children}
    </section>
  );
}

function OutcomesChart({ rows, layout }: { rows: CaregiverPerformanceRow[]; layout: ChartLayout }) {
  const sorted = [...rows].sort((a, b) => b.assigned - a.assigned);
  const max = Math.max(1, ...sorted.map((r) => r.completed + r.missed + r.excused));
  return (
    <Chart
      title="Visit outcomes by caregiver"
      hint="Excused misses were outside the caregiver's control and aren't counted against them."
    >
      <Legend items={OUTCOMES} />
      {layout === 'horizontal' ? (
        <div className="perf-charts__rows" aria-hidden>
          {sorted.map((row) => (
            <div key={row.caregiverId} className="perf-charts__row">
              <span className="perf-charts__name">{row.caregiverName}</span>
              <span className="perf-charts__track">
                {OUTCOMES.map((o) =>
                  row[o.key] > 0 ? (
                    <span
                      key={o.key}
                      className="perf-charts__segment"
                      style={{ width: `${(row[o.key] / max) * 100}%`, background: o.color }}
                    />
                  ) : null,
                )}
              </span>
              <Tooltip title={row.caregiverName} items={outcomeItems(row)} />
            </div>
          ))}
        </div>
      ) : (
        <div className="perf-charts__columns" aria-hidden>
          {sorted.map((row) => (
            <div key={row.caregiverId} className="perf-charts__column">
              <span className="perf-charts__column-label">{row.assigned} visits</span>
              <span className="perf-charts__column-plot">
                <span
                  className="perf-charts__column-bar"
                  style={{ height: `${((row.completed + row.missed + row.excused) / max) * 100}%` }}
                >
                  {[...OUTCOMES]
                    .reverse()
                    .map((o) =>
                      row[o.key] > 0 ? (
                        <span
                          key={o.key}
                          className="perf-charts__column-segment"
                          style={{ flexGrow: row[o.key], background: o.color }}
                        />
                      ) : null,
                    )}
                </span>
              </span>
              <span className="perf-charts__column-date">{row.caregiverName}</span>
              <Tooltip title={row.caregiverName} items={outcomeItems(row)} />
            </div>
          ))}
        </div>
      )}
      <table className="perf-charts__sr">
        <caption>Visit outcomes by caregiver</caption>
        <thead>
          <tr>
            <th scope="col">Caregiver</th>
            {OUTCOMES.map((o) => (
              <th key={o.key} scope="col">
                {o.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.caregiverId}>
              <th scope="row">{row.caregiverName}</th>
              {OUTCOMES.map((o) => (
                <td key={o.key}>{row[o.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Chart>
  );
}

function RatesChart({
  title,
  hint,
  rows,
  series,
  layout,
}: {
  title: string;
  hint: string;
  rows: CaregiverPerformanceRow[];
  series: [RateSeries, RateSeries];
  layout: ChartLayout;
}) {
  return (
    <Chart title={title} hint={hint}>
      <Legend items={series} />
      {layout === 'horizontal' ? (
        <div className="perf-charts__rows" aria-hidden>
          {rows.map((row) => (
            <div key={row.caregiverId} className="perf-charts__row perf-charts__row--pair">
              <span className="perf-charts__name">{row.caregiverName}</span>
              <span className="perf-charts__pair">
                {series.map((s) => {
                  const value = s.value(row);
                  return (
                    <span key={s.label} className="perf-charts__pair-line">
                      <span className="perf-charts__track perf-charts__track--thin">
                        {value !== null ? (
                          <span
                            className="perf-charts__segment"
                            style={{ width: `${value * 100}%`, background: s.color }}
                          />
                        ) : null}
                      </span>
                      <span className="perf-charts__value">{percent(value)}</span>
                    </span>
                  );
                })}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="perf-charts__columns" aria-hidden>
          {rows.map((row) => (
            <div key={row.caregiverId} className="perf-charts__column">
              <span className="perf-charts__column-plot perf-charts__column-plot--pair">
                {series.map((s) => {
                  const value = s.value(row);
                  return (
                    <span key={s.label} className="perf-charts__column-slot">
                      <span className="perf-charts__column-value">{percent(value)}</span>
                      <span
                        className="perf-charts__column-bar perf-charts__column-bar--rate"
                        // Leaves room above a full bar for its percentage label.
                        style={{
                          height: `calc(${(value ?? 0) * 100}% - ${(value ?? 0) * 22}px)`,
                          background: s.color,
                        }}
                      />
                    </span>
                  );
                })}
              </span>
              <span className="perf-charts__column-date">{row.caregiverName}</span>
            </div>
          ))}
        </div>
      )}
      <table className="perf-charts__sr">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Caregiver</th>
            {series.map((s) => (
              <th key={s.label} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.caregiverId}>
              <th scope="row">{row.caregiverName}</th>
              {series.map((s) => (
                <td key={s.label}>{percent(s.value(row))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Chart>
  );
}

interface TeamWeek {
  weekStart: string;
  completed: number;
  missed: number;
  onTime: number;
  checkedIn: number;
}

function teamWeeks(rows: CaregiverPerformanceRow[]): TeamWeek[] {
  const byWeek = new Map<string, TeamWeek>();
  for (const week of rows.flatMap((r) => r.weeks)) {
    const total = byWeek.get(week.weekStart) ?? {
      weekStart: week.weekStart,
      completed: 0,
      missed: 0,
      onTime: 0,
      checkedIn: 0,
    };
    total.completed += week.completed;
    total.missed += week.missed;
    total.onTime += week.onTime;
    total.checkedIn += week.checkedIn;
    byWeek.set(week.weekStart, total);
  }
  return [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

const onTimeRate = (week: TeamWeek) => (week.checkedIn === 0 ? null : week.onTime / week.checkedIn);

function WeeksChart({
  rows,
  filtered,
  period,
}: {
  rows: CaregiverPerformanceRow[];
  filtered: boolean;
  period: Period;
}) {
  const weeks = teamWeeks(rows);
  const max = Math.max(1, ...weeks.map((w) => w.completed + w.missed));
  const title = filtered ? 'Visits by week' : 'Team visits by week';
  return (
    <Chart
      title={title}
      hint={`Completed and missed visits each week${
        filtered ? ' for the caregivers found' : ''
      }, with the share of check-ins on time above each column.`}
      wide
    >
      <Legend items={OUTCOMES.slice(0, 2)} />
      {weeks.length === 0 ? (
        <p className="perf-charts__empty">No visits this month.</p>
      ) : (
        <div className="perf-charts__columns" aria-hidden>
          {weeks.map((week) => (
            <div key={week.weekStart} className="perf-charts__column">
              <span className="perf-charts__column-label">{percent(onTimeRate(week))} on time</span>
              <span className="perf-charts__column-plot">
                <span
                  className="perf-charts__column-bar"
                  style={{ height: `${((week.completed + week.missed) / max) * 100}%` }}
                >
                  {week.missed > 0 ? (
                    <span
                      className="perf-charts__column-segment"
                      style={{ flexGrow: week.missed, background: OUTCOMES[1].color }}
                    />
                  ) : null}
                  {week.completed > 0 ? (
                    <span
                      className="perf-charts__column-segment"
                      style={{ flexGrow: week.completed, background: OUTCOMES[0].color }}
                    />
                  ) : null}
                </span>
              </span>
              <span className="perf-charts__column-date">{weekRange(week.weekStart, period)}</span>
              <Tooltip
                title={weekRange(week.weekStart, period)}
                items={[
                  { label: 'Completed', color: OUTCOMES[0].color, value: week.completed },
                  { label: 'Missed', color: OUTCOMES[1].color, value: week.missed },
                ]}
              />
            </div>
          ))}
        </div>
      )}
      <table className="perf-charts__sr">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Completed</th>
            <th scope="col">Missed</th>
            <th scope="col">On time</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.weekStart}>
              <th scope="row">{weekRange(week.weekStart, period)}</th>
              <td>{week.completed}</td>
              <td>{week.missed}</td>
              <td>{percent(onTimeRate(week))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Chart>
  );
}

export function CaregiverPerformanceCharts({
  rows,
  period,
  layout = 'horizontal',
}: {
  rows: CaregiverPerformanceRow[];
  period: Period;
  layout?: ChartLayout;
}) {
  return (
    <div className="perf-charts">
      <OutcomesChart rows={rows} layout={layout} />
      <RatesChart
        title="Completion and punctuality"
        hint="The share of each caregiver's visits completed, and of their check-ins that were on time."
        rows={rows}
        series={PUNCTUALITY}
        layout={layout}
      />
      <WeeksChart rows={rows} filtered={layout === 'vertical'} period={period} />
    </div>
  );
}

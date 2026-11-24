// Caregiver performance as charts (2026-11-24), the same month's numbers as the table, shown when the
// supervisor presses "Show charts". Four views, each answering one question: who missed visits and
// were they excused; how complete and punctual each caregiver was; whether the team improved week
// by week; and how well each caregiver's visits were evidenced. Still no overall score (see
// CaregiverPerformanceReport.tsx). Plain HTML and CSS bars, like OutcomeTrendChart.tsx, with every
// value also written as text, and each chart's numbers in a table for screen readers.

import type { ReactNode } from 'react';
import type { CaregiverPerformanceRow } from '../../api/compliance';
import { date, percent } from './format';
import './CaregiverPerformanceCharts.css';

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

const EVIDENCE: [RateSeries, RateSeries] = [
  {
    label: 'Required tasks done',
    color: 'var(--color-accent)',
    value: (r) => r.requiredTasksDoneRate,
  },
  {
    label: 'Confirmed by family code',
    color: 'var(--color-state-awaiting)',
    value: (r) => r.qrVerifiedRate,
  },
];

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

function Chart({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="perf-charts__card">
      <h3 className="perf-charts__title">{title}</h3>
      <p className="perf-charts__hint">{hint}</p>
      {children}
    </section>
  );
}

function OutcomesChart({ rows }: { rows: CaregiverPerformanceRow[] }) {
  const sorted = [...rows].sort((a, b) => b.assigned - a.assigned);
  const max = Math.max(1, ...sorted.map((r) => r.completed + r.missed + r.excused));
  return (
    <Chart
      title="Visit outcomes by caregiver"
      hint="Excused misses were outside the caregiver's control and aren't counted against them."
    >
      <Legend items={OUTCOMES} />
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
            <span className="perf-charts__value">
              {row.completed} done
              {row.missed > 0 ? `, ${row.missed} missed` : ''}
              {row.excused > 0 ? `, ${row.excused} excused` : ''}
            </span>
          </div>
        ))}
      </div>
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
}: {
  title: string;
  hint: string;
  rows: CaregiverPerformanceRow[];
  series: [RateSeries, RateSeries];
}) {
  return (
    <Chart title={title} hint={hint}>
      <Legend items={series} />
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

const weekLabel = (weekStart: string) => date(`${weekStart}T12:00:00Z`);
const onTimeRate = (week: TeamWeek) => (week.checkedIn === 0 ? null : week.onTime / week.checkedIn);

function WeeksChart({ rows }: { rows: CaregiverPerformanceRow[] }) {
  const weeks = teamWeeks(rows);
  const max = Math.max(1, ...weeks.map((w) => w.completed + w.missed));
  return (
    <Chart
      title="Team visits by week"
      hint="Completed and missed visits each week, with the share of check-ins on time above each column."
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
              <span className="perf-charts__column-count">
                {week.completed} done{week.missed > 0 ? `, ${week.missed} missed` : ''}
              </span>
              <span className="perf-charts__column-date">Week of {weekLabel(week.weekStart)}</span>
            </div>
          ))}
        </div>
      )}
      <table className="perf-charts__sr">
        <caption>Team visits by week</caption>
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col">Completed</th>
            <th scope="col">Missed</th>
            <th scope="col">On time</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.weekStart}>
              <th scope="row">{weekLabel(week.weekStart)}</th>
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

export function CaregiverPerformanceCharts({ rows }: { rows: CaregiverPerformanceRow[] }) {
  if (rows.length === 0) {
    return <p className="compliance__message">No caregiver activity this month.</p>;
  }
  return (
    <div className="perf-charts">
      <OutcomesChart rows={rows} />
      <RatesChart
        title="Completion and punctuality"
        hint="The share of each caregiver's visits completed, and of their check-ins that were on time."
        rows={rows}
        series={PUNCTUALITY}
      />
      <WeeksChart rows={rows} />
      <RatesChart
        title="Evidence quality"
        hint="The share of required care tasks done, and of visits confirmed with the family member's code."
        rows={rows}
        series={EVIDENCE}
      />
    </div>
  );
}

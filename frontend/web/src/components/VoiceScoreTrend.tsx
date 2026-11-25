// A person's voice match scores over time (2026-11-24), shown when the supervisor presses "Show
// trend" beside Voice checks. One point per scored recording, oldest on the left, with the match
// threshold as a dashed line, so a slow slide towards it (a cold, a new phone, an ageing voice)
// shows before checks start to fail. The numbers are also in a table for screen readers.

import type { VoiceCheckHistory } from '../api/visitSchedules';
import './VoiceScoreTrend.css';

// The y-axis runs from 0.4 to 1, wide enough to show the 0.5 threshold with room below it.
const Y_MIN = 0.4;
const Y_MAX = 1;
const WIDTH = 600;
const HEIGHT = 180;

const y = (score: number) =>
  HEIGHT - ((Math.min(Y_MAX, Math.max(Y_MIN, score)) - Y_MIN) / (Y_MAX - Y_MIN)) * HEIGHT;
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function VoiceScoreTrend({ items }: { items: VoiceCheckHistory['items'] }) {
  const scored = items
    .filter((item): item is typeof item & { score: number } => item.score !== null)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

  if (scored.length < 2) {
    return (
      <p className="visit-history-list__empty">Not enough scored recordings to show a trend yet.</p>
    );
  }

  const threshold = scored.find((item) => item.threshold !== null)?.threshold ?? 0.5;
  const scores = scored.map((item) => item.score);
  const average = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  const x = (i: number) => (i / (scored.length - 1)) * WIDTH;
  const points = scored.map((item, i) => `${x(i)},${y(item.score)}`).join(' ');

  return (
    <div className="voice-trend">
      <p className="voice-trend__summary">
        Latest {scored.length} recordings · average {average.toFixed(2)} · lowest{' '}
        {Math.min(...scores).toFixed(2)} · latest {scores.at(-1)!.toFixed(2)}
      </p>
      <div className="voice-trend__chart" aria-hidden>
        <div className="voice-trend__axis">
          {[1, 0.8, 0.6].map((tick) => (
            <span key={tick} style={{ top: `${(y(tick) / HEIGHT) * 100}%` }}>
              {tick.toFixed(1)}
            </span>
          ))}
        </div>
        <div className="voice-trend__plot">
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
            {[1, 0.8, 0.6].map((tick) => (
              <line
                key={tick}
                className="voice-trend__grid"
                x1={0}
                x2={WIDTH}
                y1={y(tick)}
                y2={y(tick)}
              />
            ))}
            <line
              className="voice-trend__threshold"
              x1={0}
              x2={WIDTH}
              y1={y(threshold)}
              y2={y(threshold)}
            />
            <polyline className="voice-trend__line" points={points} />
          </svg>
          <span
            className="voice-trend__threshold-label"
            style={{ top: `${(y(threshold) / HEIGHT) * 100}%` }}
          >
            Match threshold {threshold.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="voice-trend__dates" aria-hidden>
        <span>{shortDate(scored[0]!.recordedAt)}</span>
        <span>{shortDate(scored.at(-1)!.recordedAt)}</span>
      </div>

      <table className="voice-trend__sr">
        <caption>Voice match scores over time</caption>
        <thead>
          <tr>
            <th scope="col">Recorded</th>
            <th scope="col">Score</th>
          </tr>
        </thead>
        <tbody>
          {scored.map((item) => (
            <tr key={`${item.visitScheduleId}-${item.recordedAt}`}>
              <th scope="row">{shortDate(item.recordedAt)}</th>
              <td>{item.score.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

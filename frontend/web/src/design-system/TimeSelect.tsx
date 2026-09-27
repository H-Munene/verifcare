import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useId } from 'react';
import './components.css';

// A time of day as hour, minute and AM/PM (2026-09-27, after the user's
// temp_images/check_in_check_out_select_time_ui.PNG), for the visit form's check-in and check-out
// times. The hour and minute are native selects under the styling, so keyboard and screen-reader
// support come for free; AM/PM is a pair of pressed-state buttons. The value is 24-hour "HH:MM".

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTE_STEP = 5;

function parse(value: string): { hour12: number; minute: number; pm: boolean } {
  const [h = 9, m = 0] = value.split(':').map(Number);
  return { hour12: h % 12 === 0 ? 12 : h % 12, minute: m, pm: h >= 12 };
}

function format(hour12: number, minute: number, pm: boolean): string {
  const h = (hour12 % 12) + (pm ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function TimeSelect({
  label,
  value,
  onChange,
}: {
  /** Names the whole control, e.g. "Check-in time". */
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const labelId = useId();
  const { hour12, minute, pm } = parse(value);
  // Five-minute steps, plus the current minute if it's between them (a visit saved elsewhere).
  const minutes = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);
  if (!minutes.includes(minute)) {
    minutes.push(minute);
    minutes.sort((a, b) => a - b);
  }

  return (
    <div className="ds-time-select" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <span className="ds-time-select__field">
        <select
          aria-label={`${label}, hour`}
          value={hour12}
          onChange={(event) => onChange(format(Number(event.target.value), minute, pm))}
        >
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={2} aria-hidden />
      </span>
      <span className="ds-time-select__colon" aria-hidden>
        :
      </span>
      <span className="ds-time-select__field">
        <select
          aria-label={`${label}, minutes`}
          value={minute}
          onChange={(event) => onChange(format(hour12, Number(event.target.value), pm))}
        >
          {minutes.map((m) => (
            <option key={m} value={m}>
              {String(m).padStart(2, '0')}
            </option>
          ))}
        </select>
        <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={2} aria-hidden />
      </span>
      <span className="ds-time-select__period">
        {(['AM', 'PM'] as const).map((period) => {
          const selected = (period === 'PM') === pm;
          return (
            <button
              key={period}
              type="button"
              aria-pressed={selected}
              aria-label={`${label}, ${period}`}
              className={
                selected
                  ? 'ds-time-select__period-button ds-time-select__period-button--selected'
                  : 'ds-time-select__period-button'
              }
              onClick={() => onChange(format(hour12, minute, period === 'PM'))}
            >
              {period}
            </button>
          );
        })}
      </span>
    </div>
  );
}

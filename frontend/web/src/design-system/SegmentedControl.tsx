import { useRef, type KeyboardEvent } from 'react';
import './components.css';

// A row of joined buttons that switches between views of one panel (2026-09-26, first used for
// the Overview's "Needs your attention" categories), like the week/month/year switch in the
// user's inspiration images. It is a tab list to assistive tech: one tab stop, arrow keys move
// between segments, and each segment names the panel it controls.

export interface Segment {
  id: string;
  label: string;
  /** Shown after the label, e.g. how many items the segment holds. */
  count?: number;
}

export interface SegmentedControlProps {
  segments: Segment[];
  selected: string;
  onChange: (id: string) => void;
  /** Names the group, e.g. "Attention categories". */
  label: string;
  /** Prefix for the ids of the panels each segment controls: `${idPrefix}-${segment.id}`. */
  idPrefix: string;
}

export function SegmentedControl({
  segments,
  selected,
  onChange,
  label,
  idPrefix,
}: SegmentedControlProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = segments.findIndex((s) => s.id === selected);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const target =
      step !== undefined
        ? (current + step + segments.length) % segments.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? segments.length - 1
            : undefined;
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    onChange(segments[target]!.id);
    refs.current[target]?.focus();
  }

  return (
    <div className="ds-segmented" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {segments.map((segment, index) => {
        const isSelected = segment.id === selected;
        return (
          <button
            key={segment.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${segment.id}`}
            aria-selected={isSelected}
            aria-controls={`${idPrefix}-${segment.id}`}
            tabIndex={isSelected ? 0 : -1}
            className={[
              'ds-segmented__segment',
              isSelected ? 'ds-segmented__segment--selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => onChange(segment.id)}
          >
            {segment.label}
            {segment.count !== undefined ? (
              <span className="ds-segmented__count">{segment.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

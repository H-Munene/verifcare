import { Cancel01Icon, MinusSignIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import './components.css';

// A vertical timeline of timestamped events (a visit's check-in steps). Each step shows a small
// grey mark with no circle around it (2026-09-27, user request): a tick when it happened, a dash
// while it's still to come, and a cross when it didn't happen and now won't. The state is named
// for screen readers too.
export type TimelineStepState = 'done' | 'pending' | 'skipped';

export interface TimelineStep {
  label: string;
  timestamp: string | null;
  /** Defaults to done when there's a timestamp, else pending. */
  state?: TimelineStepState;
  detail?: string;
}

const MARKS = {
  done: { icon: Tick02Icon, text: 'done', fallback: '' },
  pending: { icon: MinusSignIcon, text: 'not yet', fallback: 'Not yet' },
  skipped: { icon: Cancel01Icon, text: 'not done', fallback: 'Not done' },
} as const;

function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <div className="ds-timeline">
      {steps.map((step, index) => {
        const state = step.state ?? (step.timestamp ? 'done' : 'pending');
        const mark = MARKS[state];
        return (
          <div className={`ds-timeline__step ds-timeline__step--${state}`} key={step.label}>
            <div className="ds-timeline__rail">
              <HugeiconsIcon
                icon={mark.icon}
                size={14}
                strokeWidth={2.2}
                className="ds-timeline__mark"
                aria-hidden
              />
              {index < steps.length - 1 ? <div className="ds-timeline__line" /> : null}
            </div>
            <div className="ds-timeline__content">
              <div className="ds-timeline__label">
                {step.label}
                <span className="sr-only">, {mark.text}</span>
              </div>
              <div className="ds-timeline__timestamp">
                {step.timestamp ? formatTimestamp(step.timestamp) : mark.fallback}
              </div>
              {step.detail ? <div className="ds-timeline__detail">{step.detail}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

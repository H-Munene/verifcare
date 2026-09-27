import { Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import './components.css';

// A vertical progress timeline for a real-world sequence of timestamped events (the visit detail
// page's check-in -> photo verifications -> check-out story) - distinct from Stepper.tsx's
// horizontal wizard-step indicator, which has no room for a timestamp under each step and implies
// a "current step" the user is actively on, not a record of when past events happened.
export interface TimelineStep {
  label: string;
  timestamp: string | null;
  detail?: string;
}

function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <div className="ds-timeline">
      {steps.map((step, index) => {
        const isComplete = step.timestamp !== null;
        return (
          <div className="ds-timeline__step" key={step.label}>
            <div className="ds-timeline__rail">
              {/* Done: a green tick. Not yet: a dashed circle (after temp_images/timeline_ui.png). */}
              <div
                className={'ds-timeline__dot' + (isComplete ? ' ds-timeline__dot--complete' : '')}
              >
                {isComplete ? (
                  <HugeiconsIcon icon={Tick02Icon} size={10} strokeWidth={3} aria-hidden />
                ) : null}
              </div>
              {index < steps.length - 1 ? (
                <div
                  className={
                    'ds-timeline__line' + (isComplete ? ' ds-timeline__line--complete' : '')
                  }
                />
              ) : null}
            </div>
            <div className="ds-timeline__content">
              <div className="ds-timeline__label">
                {step.label}
                <span className="sr-only">{isComplete ? ', done' : ', not yet'}</span>
              </div>
              <div className="ds-timeline__timestamp">
                {step.timestamp ? formatTimestamp(step.timestamp) : 'Not yet'}
              </div>
              {step.detail ? <div className="ds-timeline__detail">{step.detail}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

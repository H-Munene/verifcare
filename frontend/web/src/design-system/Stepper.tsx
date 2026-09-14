import './components.css';

export interface StepperProps {
  steps: string[];
  currentStepIndex: number;
}

// Horizontal numbered-step indicator (inspired by a standard e-commerce checkout stepper): a
// filled accent circle for the current and completed steps (completed ones show a checkmark), an
// outlined circle for steps not yet reached, connected by a line that fills in accent color behind
// completed steps.
export function Stepper({ steps, currentStepIndex }: StepperProps) {
  return (
    <div className="ds-stepper">
      {steps.map((label, index) => {
        const isCompleted = index < currentStepIndex;
        const isCurrent = index === currentStepIndex;
        return (
          <div className="ds-stepper__step" key={label}>
            <div
              className={[
                'ds-stepper__circle',
                isCompleted || isCurrent ? 'ds-stepper__circle--active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {isCompleted ? '✓' : index + 1}
            </div>
            {index < steps.length - 1 ? (
              <div
                className={[
                  'ds-stepper__connector',
                  isCompleted ? 'ds-stepper__connector--completed' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
            ) : null}
            <div className="ds-stepper__label">{label}</div>
          </div>
        );
      })}
    </div>
  );
}

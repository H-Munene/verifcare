import { useId, useRef, type ReactNode } from 'react';
import './components.css';
import { useDialogLayer } from './useDialogLayer';

export interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Blocks Escape and backdrop dismissal, e.g. while an upload is in flight. */
  dismissible?: boolean;
}

// Real shadow only for things that float above the page - dropdown menus, popovers, and modals,
// per the design system spec's elevation rules. A real modal dialog for assistive technology too
// (2026-09-27): named by its title, focus kept inside it, Escape closes it.
export function Modal({ title, onClose, children, dismissible = true }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogLayer({ containerRef: dialogRef, onDismiss: dismissible ? onClose : undefined });

  return (
    <div className="ds-modal-overlay" onClick={dismissible ? onClose : undefined}>
      <div
        ref={dialogRef}
        className="ds-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div id={titleId} className="ds-modal__title">
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

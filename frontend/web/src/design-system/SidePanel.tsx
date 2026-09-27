import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './components.css';

// A panel that slides in from the right over a dimmed page (2026-09-27, after the user's
// temp_images/sidepanel.png): the alerts panel behind the top bar's bell, and a visit's details
// from the Visits table. It is a modal dialog: focus moves into it, Escape or a click on the
// dimmed page closes it, and focus returns to whatever opened it.

export interface SidePanelProps {
  title: ReactNode;
  /** A line above the title, e.g. what kind of record this is. */
  eyebrow?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Pinned under the content, e.g. actions. */
  footer?: ReactNode;
}

export function SidePanel({ title, eyebrow, onClose, children, footer }: SidePanelProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab' && panelRef.current) {
        // Keep Tab inside the panel while it's open.
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div className="ds-side-panel-overlay" onClick={onClose}>
      <div
        ref={panelRef}
        className="ds-side-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ds-side-panel__head">
          <div className="ds-side-panel__heading">
            {eyebrow ? <div className="ds-side-panel__eyebrow">{eyebrow}</div> : null}
            <h2 id={titleId} className="ds-side-panel__title">
              {title}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="ds-side-panel__close"
            aria-label="Close"
            onClick={onClose}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={18} strokeWidth={1.8} aria-hidden />
          </button>
        </div>
        <div className="ds-side-panel__body">{children}</div>
        {footer ? <div className="ds-side-panel__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

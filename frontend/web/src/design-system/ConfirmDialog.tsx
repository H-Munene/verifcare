import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import './ConfirmDialog.css';
import { useDialogLayer } from './useDialogLayer';

// "Are you sure?" before an action that's hard to take back (2026-09-27): changing a dependant's
// primary contact, cancelling a visit. An alertdialog, so screen readers read the question out as soon as it opens.
//
// Focus starts on Cancel for a destructive action and on the confirm button otherwise - the WAI-
// ARIA practice of focusing the least harmful choice, so a stray Enter can't do the damage.
// Escape and a click outside cancel, except while the action is running, when neither can
// abandon a request half way. It floats above side panels (its own layer in useDialogLayer),
// and it's portalled to <body> so a panel's overflow can't clip it.

export interface ConfirmDialogProps {
  title: ReactNode;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button and Cancel focused first, for actions that remove or reject something. */
  destructive?: boolean;
  /** The action is running: buttons are disabled and the dialog can't be dismissed. */
  pending?: boolean;
  pendingLabel?: string;
  /** Why the action failed, shown in the dialog so the person can retry or cancel. */
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  pending = false,
  pendingLabel,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useDialogLayer({
    containerRef: dialogRef,
    onDismiss: pending ? undefined : onCancel,
    initialFocusRef: destructive ? cancelRef : confirmRef,
  });

  return createPortal(
    <div className="ds-confirm-overlay" onClick={pending ? undefined : onCancel}>
      <div
        ref={dialogRef}
        className="ds-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="ds-confirm__title">
          {title}
        </h2>
        <div id={messageId} className="ds-confirm__message">
          {message}
        </div>
        {error ? (
          <div className="ds-confirm__error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="ds-confirm__actions">
          <Button ref={cancelRef} type="button" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            variant="primary"
            className={destructive ? 'ds-button--destructive' : undefined}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? (pendingLabel ?? `${confirmLabel}...`) : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

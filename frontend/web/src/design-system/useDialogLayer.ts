import { useEffect, useRef, type RefObject } from 'react';

// Keyboard and focus behaviour shared by Modal and ConfirmDialog: focus moves into the dialog,
// Tab stays inside it, Escape dismisses it, and focus goes back to whatever opened it.
//
// Dialogs can stack (a ConfirmDialog opened from inside a SidePanel, or from a Modal), so only the
// top-most layer reacts to a key. The listener runs in the capture phase on window and stops the
// event there, which keeps layers underneath - including SidePanel, whose own listener sits on
// document - from also closing on the same Escape press or fighting over Tab.

const openLayers: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialogLayer({
  containerRef,
  onDismiss,
  initialFocusRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
  /** Escape. Leave undefined while dismissing isn't allowed (e.g. a request is in flight). */
  onDismiss: (() => void) | undefined;
  /** What to focus on open; defaults to the first focusable element in the dialog. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  // Read through a ref so a new onDismiss each render doesn't re-run the effect, which would
  // re-focus the dialog's first control mid-interaction.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    const layer = Symbol('dialog-layer');
    openLayers.push(layer);
    const opener = document.activeElement as HTMLElement | null;
    // If the opener is gone by the time this closes (e.g. "Make primary contact" disappears once
    // it has worked), focus lands in the dialog it lived in rather than falling out to <body>.
    const openerDialog = opener?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]');
    const container = containerRef.current;
    (initialFocusRef?.current ?? container?.querySelector<HTMLElement>(FOCUSABLE))?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (openLayers[openLayers.length - 1] !== layer || !container) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismissRef.current?.();
      } else if (event.key === 'Tab') {
        event.stopPropagation();
        const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !container.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !container.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      openLayers.splice(openLayers.indexOf(layer), 1);
      if (opener?.isConnected) {
        opener.focus();
      } else if (openerDialog?.isConnected) {
        openerDialog.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      }
    };
    // Mount/unmount only: the refs are stable and onDismiss is read through dismissRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

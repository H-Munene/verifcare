import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useSyncExternalStore } from 'react';
import './Toast.css';
import { dismissToast, getToasts, subscribeToToasts } from './toastStore';

export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToToasts, getToasts);
  return (
    <div className="ds-toaster" aria-live="assertive">
      {toasts.map((toast) => (
        <div key={toast.id} className="ds-toast" role="alert">
          <span className="ds-toast__message">{toast.message}</span>
          <button
            type="button"
            className="ds-toast__dismiss"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

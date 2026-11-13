// Error toasts: one store the whole app reports into, so a failure from a query, a mutation or a
// sign-in attempt reads the same everywhere. <Toaster /> (Toast.tsx) renders it.

export interface ToastItem {
  id: number;
  message: string;
}

const DISMISS_AFTER_MS = 6000;

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeToToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): ToastItem[] {
  return toasts;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function showErrorToast(message: string): void {
  // The same failure reported twice (a retried query, a double click) shows once.
  if (toasts.some((toast) => toast.message === message)) {
    return;
  }
  const id = nextId++;
  toasts = [...toasts, { id, message }];
  emit();
  setTimeout(() => dismissToast(id), DISMISS_AFTER_MS);
}

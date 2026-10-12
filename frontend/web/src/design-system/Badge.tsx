import type { ReactNode } from 'react';
import './components.css';

// Only success and danger have colors; every other status is neutral gray.
export type BadgeTone = 'success' | 'danger' | 'neutral';

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`ds-badge ds-badge--${tone}`}>{children}</span>;
}

import type { ReactNode } from 'react';
import './components.css';

// Tags are for user-assigned attributes (e.g. "Primary contact"); use Badge for computed status.
export function Tag({ children }: { children: ReactNode }) {
  return <span className="ds-tag">{children}</span>;
}

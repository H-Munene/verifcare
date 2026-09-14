import type { ReactNode } from 'react';
import './components.css';

// Tags (blue-tint, accent-tint text) describe user-assigned attributes (e.g. relationship type,
// "Primary contact"). Badges (design-system/Badge.tsx) describe system-computed status instead -
// never use one palette for the other's job, per the design system spec.
export function Tag({ children }: { children: ReactNode }) {
  return <span className="ds-tag">{children}</span>;
}

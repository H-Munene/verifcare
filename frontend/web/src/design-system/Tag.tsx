import type { ReactNode } from 'react';
import './components.css';

// Tags (blue-tint, accent-tint text) describe user-assigned attributes (e.g. relationship type,
// "Primary contact"). Badges (design-system/Badge.tsx) describe system-computed status instead -
// never use one palette for the other's job, per the design system spec. The neutral tone is
// the quieter counterpart of an accent tag (2026-09-27: "Secondary contact" beside "Primary
// contact"), so the one that matters stands out.
export function Tag({
  tone = 'accent',
  children,
}: {
  tone?: 'accent' | 'neutral';
  children: ReactNode;
}) {
  return (
    <span className={tone === 'neutral' ? 'ds-tag ds-tag--neutral' : 'ds-tag'}>{children}</span>
  );
}

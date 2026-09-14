import type { ReactNode } from 'react';
import './components.css';

// The design system spec only defines success (green) and danger (red) explicitly for
// system-computed status. Every other status value this app actually renders (dependant/user
// active-vs-deactivated, visit "in_progress") was an explicit, disclosed assumption in the
// wireframe canvas itself (temp_images/Mzazi Care Admin Wireframes.dc.html's "Assumptions" note):
// non-success statuses get a neutral gray fill, never invented as a new color.
export type BadgeTone = 'success' | 'danger' | 'neutral';

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`ds-badge ds-badge--${tone}`}>{children}</span>;
}

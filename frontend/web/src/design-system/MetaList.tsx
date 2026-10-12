import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ReactNode } from 'react';
import './components.css';

// A record's key facts under its name (2026-09-27, user request: the caregiver and dependant
// pages' "A · B · C" line, shown minimally but more beautifully): each fact behind a small muted
// icon, spaced out rather than joined with dots, wrapping on a narrow screen. The icon is
// decorative; each fact's label says what it is where the value alone wouldn't.

export interface MetaItem {
  icon: IconSvgElement;
  children: ReactNode;
  /** A fuller description on hover, e.g. the exact date behind "48 years". */
  title?: string;
}

export function MetaList({ items }: { items: MetaItem[] }) {
  return (
    <ul className="ds-meta-list">
      {items.map((item, index) => (
        <li key={index} title={item.title}>
          <HugeiconsIcon icon={item.icon} size={15} strokeWidth={1.6} aria-hidden />
          <span>{item.children}</span>
        </li>
      ))}
    </ul>
  );
}

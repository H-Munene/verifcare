import type { CSSProperties, ReactNode } from 'react';
import './components.css';

// A row of headline figures in the Overview's hairline-grid look (2026-09-27, the Compliance
// tab): tiles share 1px borders, the grid gap showing the border colour through, with sharp
// corners and the Overview's light hover. Each tile is a label, one big figure and an optional
// line of detail. On a narrow screen the tiles go two to a row, the last one spanning the row
// when there's an odd number, so no empty grey cell shows through.

export interface StatTile {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}

export function StatTiles({ tiles, label }: { tiles: StatTile[]; label: string }) {
  return (
    <section
      className="ds-stat-tiles"
      aria-label={label}
      style={{ '--ds-stat-tiles-count': tiles.length } as CSSProperties}
    >
      {tiles.map((tile) => (
        <div key={tile.label} className="ds-stat-tiles__tile">
          <span className="ds-stat-tiles__label">{tile.label}</span>
          <span className="ds-stat-tiles__value">{tile.value}</span>
          {tile.detail ? <span className="ds-stat-tiles__detail">{tile.detail}</span> : null}
        </div>
      ))}
    </section>
  );
}

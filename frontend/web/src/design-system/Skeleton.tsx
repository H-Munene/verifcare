import type { CSSProperties, ReactNode } from 'react';
import { TableFrame } from './Table';
import './components.css';

// Loading placeholders (2026-09-27, user request) shaped like the content they stand in for, so
// the page doesn't jump when it arrives. Each loading region announces itself once to screen
// readers ("Loading..."), and the shimmer stops for reduced-motion users.

/** One grey block; size it to the text or element it replaces. */
export function Skeleton({
  width = '100%',
  height = 14,
  radius,
  style,
}: {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  radius?: CSSProperties['borderRadius'];
  style?: CSSProperties;
}) {
  return (
    <span
      className="ds-skeleton"
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden
    />
  );
}

/** Wraps a loading region: one announcement, the placeholders hidden from screen readers. */
export function SkeletonRegion({
  label = 'Loading',
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className} role="status" aria-live="polite">
      <span className="sr-only">{label}...</span>
      <div aria-hidden>{children}</div>
    </div>
  );
}

/** A table's frame with placeholder headings and rows, for a list that's loading. */
export function TableSkeleton({ columns, rows = 6 }: { columns: number; rows?: number }) {
  // Varied widths, so it reads as text rather than a grid of bars.
  const widths = ['62%', '45%', '70%', '38%', '55%'];
  return (
    <SkeletonRegion label="Loading the list">
      <TableFrame>
        <table className="ds-table ds-table--table-cell">
          <thead>
            <tr>
              {Array.from({ length: columns }, (_, c) => (
                <th key={c}>
                  <Skeleton width={c === 0 ? 90 : 70} height={12} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r}>
                {Array.from({ length: columns }, (_, c) => (
                  <td key={c}>
                    <Skeleton width={widths[(r + c) % widths.length]} height={12} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </SkeletonRegion>
  );
}

/** A record page loading: a title, a line under it, then label/value rows. */
export function DetailSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <SkeletonRegion label="Loading" className="ds-skeleton-detail">
      <Skeleton width={260} height={26} />
      <Skeleton width={180} height={13} style={{ marginTop: 10 }} />
      <div className="ds-skeleton-detail__rows">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="ds-skeleton-detail__row">
            <Skeleton width={110} height={12} />
            <Skeleton width={['55%', '40%', '65%'][i % 3]} height={14} />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

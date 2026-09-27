// The table look from the user's inspiration (temp_images/table.png, table2.PNG, 2026-09-26): a
// rounded frame, an icon beside each column heading, column dividers, zebra rows, and sortable
// headings with an arrow showing the order. Tables stay plain <table> markup; these pieces are
// the frame and the heading cells.

import { ArrowDown01Icon, ArrowUp01Icon, ArrowUpDownIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ReactNode, ThHTMLAttributes } from 'react';
import './components.css';

/** The rounded frame; scrolls sideways on a narrow screen rather than squashing columns. */
export function TableFrame({ children }: { children: ReactNode }) {
  return <div className="ds-table-frame">{children}</div>;
}

interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  icon?: IconSvgElement;
  children?: ReactNode;
}

/** A column heading with its icon. */
export function Th({ icon, children, className, ...rest }: ThProps) {
  return (
    <th className={['ds-table__th', className].filter(Boolean).join(' ')} {...rest}>
      <span className="ds-table__heading">
        {icon ? <HugeiconsIcon icon={icon} size={15} strokeWidth={1.6} aria-hidden /> : null}
        {children}
      </span>
    </th>
  );
}

export type SortDirection = 'ascending' | 'descending';

interface SortableThProps extends ThProps {
  /** This column's current order, or undefined when the table is sorted by another. */
  direction: SortDirection | undefined;
  onSort: () => void;
}

/**
 * A heading that sorts the table by its column. aria-sort tells screen readers the current order;
 * the button's label says what a click will do.
 */
export function SortableTh({
  icon,
  children,
  direction,
  onSort,
  className,
  ...rest
}: SortableThProps) {
  const sortIcon =
    direction === 'ascending'
      ? ArrowUp01Icon
      : direction === 'descending'
        ? ArrowDown01Icon
        : ArrowUpDownIcon;
  return (
    <th
      className={['ds-table__th', className].filter(Boolean).join(' ')}
      aria-sort={direction ?? 'none'}
      {...rest}
    >
      <button
        type="button"
        className={['ds-table__sort', direction ? 'ds-table__sort--active' : ''].join(' ')}
        onClick={onSort}
      >
        <span className="ds-table__heading">
          {icon ? <HugeiconsIcon icon={icon} size={15} strokeWidth={1.6} aria-hidden /> : null}
          {children}
        </span>
        <HugeiconsIcon
          icon={sortIcon}
          size={14}
          strokeWidth={1.8}
          className="ds-table__sort-icon"
          aria-hidden
        />
      </button>
    </th>
  );
}

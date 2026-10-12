// A table filter (2026-09-26, user request): a button that opens a context menu in the style of
// temp_images/context_menu.png - grouped items split by rules, a tick and accent colour on the
// chosen one. The first group is "all" (no filter), the second the choices. A long list (a
// caregiver or dependant picker) gets a search box above it.
//
// Keyboard: Enter, Space or Down on the button opens it with the chosen item focused; Up/Down,
// Home/End move; Enter or Space chooses; Escape closes; Tab closes and moves on. Focus returns
// to the button when the menu closes from inside it.

import { ArrowDown01Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import './components.css';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterMenuProps {
  /** What the filter is on, e.g. "Status". */
  label: string;
  icon: IconSvgElement;
  /** The chosen value, or '' for no filter. */
  value: string;
  /** The no-filter choice, e.g. "All statuses". */
  allLabel: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  /** Shows a search box above the options; for long lists. */
  searchPlaceholder?: string;
}

export function FilterMenu({
  label,
  icon,
  value,
  allLabel,
  options,
  onChange,
  searchPlaceholder,
}: FilterMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const chosen = options.find((o) => o.value === value);
  const visible = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;
  // Item 0 is "all"; the options follow.
  const items: FilterOption[] = [{ value: '', label: allLabel }, ...visible];

  // Close on a click anywhere outside.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function openMenu() {
    setQuery('');
    setOpen(true);
    // After render: the search box for a long list, else the chosen item.
    requestAnimationFrame(() => {
      if (searchPlaceholder) {
        searchRef.current?.focus();
      } else {
        const index = Math.max(
          0,
          items.findIndex((item) => item.value === value),
        );
        itemRefs.current[index]?.focus();
      }
    });
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) {
      buttonRef.current?.focus();
    }
  }

  function choose(next: string) {
    onChange(next);
    close(true);
  }

  function focusItem(index: number) {
    const count = items.length;
    itemRefs.current[(index + count) % count]?.focus();
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
      case 'ArrowDown':
        event.preventDefault();
        focusItem(current + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (current <= 0 && searchPlaceholder) {
          searchRef.current?.focus();
        } else {
          focusItem(current - 1);
        }
        break;
      case 'Home':
        if (current >= 0) {
          event.preventDefault();
          focusItem(0);
        }
        break;
      case 'End':
        if (current >= 0) {
          event.preventDefault();
          focusItem(items.length - 1);
        }
        break;
    }
  }

  return (
    <div className="ds-filter" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={['ds-filter__button', value ? 'ds-filter__button--applied' : ''].join(' ')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <HugeiconsIcon icon={icon} size={15} strokeWidth={1.6} aria-hidden />
        <span>
          {label}
          {chosen ? <span className="ds-filter__value">: {chosen.label}</span> : null}
        </span>
        <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.8} aria-hidden />
      </button>

      {open ? (
        <div className="ds-menu" onKeyDown={onMenuKeyDown}>
          {searchPlaceholder ? (
            <div className="ds-menu__search">
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                aria-controls={menuId}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    event.stopPropagation();
                    focusItem(0);
                  }
                }}
              />
            </div>
          ) : null}
          <div id={menuId} role="menu" aria-label={label}>
            {items.map((item, index) => {
              const selected = item.value === value;
              return (
                <div key={item.value || 'all'} role="none">
                  {/* A rule between the "all" group and the choices. */}
                  {index === 1 ? <div className="ds-menu__rule" role="separator" /> : null}
                  <button
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    tabIndex={-1}
                    className={['ds-menu__item', selected ? 'ds-menu__item--selected' : ''].join(
                      ' ',
                    )}
                    onClick={() => choose(item.value)}
                  >
                    <span className="ds-menu__tick" aria-hidden>
                      {selected ? (
                        <HugeiconsIcon icon={Tick02Icon} size={15} strokeWidth={2} />
                      ) : null}
                    </span>
                    {item.label}
                  </button>
                </div>
              );
            })}
            {visible.length === 0 ? (
              <div className="ds-menu__empty">No matches for "{query.trim()}".</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A row of filter buttons above a table, with a way to clear them all. */
export function FilterBar({
  children,
  onClear,
}: {
  children: ReactNode;
  /** Shown when any filter is applied. */
  onClear?: () => void;
}) {
  return (
    <div className="ds-filter-bar">
      {children}
      {onClear ? (
        <button type="button" className="ds-filter-bar__clear" onClick={onClear}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

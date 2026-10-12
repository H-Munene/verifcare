import { MoreVerticalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import './components.css';

// A row's actions behind a vertical ellipsis (2026-09-27, user request: Edit and Cancel on each
// visit row become a menu). The menu uses FilterMenu's look, each item with an uncoloured icon.
// It's positioned against the window (in a portal) because the table frame it sits in clips
// anything that overflows it. Keyboard: Enter/Space/Down opens on the first item, Up/Down move,
// Escape closes and returns focus to the button; scrolling or resizing closes it.

export interface ActionMenuItem {
  label: string;
  icon: IconSvgElement;
  onSelect: () => void;
  disabled?: boolean;
}

export function ActionMenu({ label, items }: { label: string; items: ActionMenuItem[] }) {
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const open = position !== null;

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = () => setPosition(null);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  function openMenu() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    requestAnimationFrame(() => itemRefs.current.find((el) => el && !el.disabled)?.focus());
  }

  function close(returnFocus: boolean) {
    setPosition(null);
    if (returnFocus) {
      buttonRef.current?.focus();
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const enabled = itemRefs.current.filter((el): el is HTMLButtonElement => !!el && !el.disabled);
    const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      enabled[(current + step + enabled.length) % enabled.length]?.focus();
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="ds-action-menu__button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          // Rows are clickable themselves; this button mustn't also open the row.
          event.stopPropagation();
          if (open) {
            close(false);
          } else {
            openMenu();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <HugeiconsIcon icon={MoreVerticalIcon} size={18} strokeWidth={1.8} aria-hidden />
      </button>
      {position
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="ds-menu ds-action-menu"
              role="menu"
              aria-label={label}
              style={{ position: 'fixed', top: position.top, right: position.right, left: 'auto' }}
              onKeyDown={onMenuKeyDown}
              onClick={(event) => event.stopPropagation()}
            >
              {items.map((item, index) => (
                <button
                  key={item.label}
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="ds-menu__item"
                  disabled={item.disabled}
                  onClick={() => {
                    close(true);
                    item.onSelect();
                  }}
                >
                  <HugeiconsIcon icon={item.icon} size={16} strokeWidth={1.7} aria-hidden />
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

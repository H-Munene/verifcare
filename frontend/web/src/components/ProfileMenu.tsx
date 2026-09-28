// The signed-in person at the foot of the sidebar (2026-09-27, user request, after
// temp_images/profile_name.png): initials, their name from their user record (not their email),
// and a chevron; it opens a small menu with Sign out. The menu opens upwards, since the button
// sits at the bottom of the screen. It follows FilterMenu's behaviour: Escape or a click outside
// closes it, and focus returns to the button.

import { ArrowDown01Icon, Logout03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import './ProfileMenu.css';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

export function ProfileMenu() {
  const { identity, signOut } = useAuth();
  const { users } = useApi();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const meQuery = useQuery({ queryKey: ['me'], queryFn: () => users.getMe() });
  // Until the record arrives (or if it can't be fetched), the part of the email before the @.
  const name = meQuery.data?.fullName ?? identity?.email?.split('@')[0] ?? 'Signed in';

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

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <div className="profile-menu" ref={rootRef}>
      {open ? (
        <div
          id={menuId}
          className="ds-menu profile-menu__menu"
          role="menu"
          aria-label="Account"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            } else if (event.key === 'Tab') {
              setOpen(false);
            }
          }}
        >
          {identity?.email ? (
            <div className="profile-menu__email" role="none">
              {identity.email}
            </div>
          ) : null}
          <button
            ref={itemRef}
            type="button"
            role="menuitem"
            className="ds-menu__item"
            onClick={signOut}
          >
            <HugeiconsIcon icon={Logout03Icon} size={16} strokeWidth={1.7} aria-hidden />
            Sign out
          </button>
        </div>
      ) : null}
      <button
        ref={buttonRef}
        type="button"
        className="profile-menu__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            setOpen(true);
            requestAnimationFrame(() => itemRef.current?.focus());
          }
        }}
      >
        <span className="profile-menu__avatar" aria-hidden>
          {initials(name)}
        </span>
        <span className="profile-menu__name">{name}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={14}
          strokeWidth={1.8}
          className="profile-menu__chevron"
          aria-hidden
        />
      </button>
    </div>
  );
}

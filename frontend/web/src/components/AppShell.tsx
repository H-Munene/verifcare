import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import {
  CalendarCheckIn01Icon,
  DashboardSquare01Icon,
  HandHeartIcon,
  SecurityCheckIcon,
  UserGroupIcon,
} from '@hugeicons/core-free-icons';
import { NavItem } from '../design-system/NavItem';
import { AlertsBell } from './AlertsBell';
import { Breadcrumbs } from './Breadcrumbs';
import { ErrorBoundary } from './ErrorBoundary';
import { ProfileMenu } from './ProfileMenu';
import './AppShell.css';

// Matches the wireframe's global chrome (temp_images's design prompt): left sidebar nav with all
// sections, top bar with the signed-in user's identity and sign-out. Overview, Caregivers,
// Dependants and Visits are real routes - every other section renders present-but-disabled, so the
// shell matches the design without claiming functionality that doesn't exist yet.
// Icons are Hugeicons, stroke style (2026-09-26): caregivers are the staff (a group), dependants
// the people cared for (a hand holding a heart).
// Alerts moved from here to the top bar's bell (2026-09-27, user request).
const NAV_SECTIONS = [
  { label: 'Overview', path: '/overview', icon: DashboardSquare01Icon },
  { label: 'Visits', path: '/visits', icon: CalendarCheckIn01Icon },
  { label: 'Caregivers', path: '/caregivers', icon: UserGroupIcon },
  { label: 'Dependants', path: '/dependants', icon: HandHeartIcon },
  { label: 'Compliance', path: '/compliance', icon: SecurityCheckIcon },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { identity } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Every /caregivers route is supervisor-only on the backend (requireRole('supervisor') covers
  // the whole router, not just registration - a caregiver can never self-register, confirmed with
  // the user) - disabled here too for a signed-in non-supervisor, rather than only finding out via
  // a failed request, the same "hide what you can't use" treatment Reviews/Make
  // Primary/the dependant status field already get elsewhere in this app. Visits gets the same
  // treatment: GET /visit-schedules is open to all three roles, but this app is the Supervisor
  // Console (confirmed with the user, not widened to a read-only view for other roles) - every
  // main page here stays supervisor-only, Visits included.
  const isSupervisor = identity?.role === 'supervisor';
  const segments = location.pathname.split('/').filter(Boolean);
  const topLevelTitle =
    segments.length === 1
      ? NAV_SECTIONS.find((section) => section.path === `/${segments[0]}`)?.label
      : undefined;
  const supervisorOnlySections = new Set([
    'Overview',
    'Visits',
    'Caregivers',
    'Reviews',
    'Compliance',
  ]);
  const navSections = NAV_SECTIONS.map((section) =>
    supervisorOnlySections.has(section.label) && !isSupervisor
      ? { ...section, path: undefined }
      : section,
  );

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="app-shell__brand">
          <div className="app-shell__brand-title">Mzazi Care</div>
        </div>
        <nav className="app-shell__nav">
          {navSections.map((section) => (
            <NavItem
              key={section.label}
              label={section.label}
              icon={section.icon}
              disabled={!section.path}
              active={Boolean(section.path && location.pathname.startsWith(section.path))}
              onClick={
                section.path
                  ? () => {
                      void navigate(section.path);
                    }
                  : undefined
              }
            />
          ))}
        </nav>
        <ProfileMenu />
      </aside>
      <div className="app-shell__main">
        <header className="app-shell__topbar">
          <div className="app-shell__topbar-left">
            {/* A top-level page's title lives here, level with the alerts bell (user request,
                2026-09-27), still the page's main heading; deeper pages show breadcrumbs. */}
            {topLevelTitle ? <h1 className="app-shell__title">{topLevelTitle}</h1> : null}
            <Breadcrumbs />
          </div>
          <div className="app-shell__topbar-right">{isSupervisor ? <AlertsBell /> : null}</div>
        </header>
        <main className="app-shell__content">
          {/* A page that fails to render shows a message here instead of blanking the app; keyed
              by route, so moving to another page tries again. */}
          <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

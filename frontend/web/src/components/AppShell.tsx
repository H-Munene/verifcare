import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { NavItem } from '../design-system/NavItem';
import './AppShell.css';

// Matches the wireframe's global chrome (temp_images's design prompt): left sidebar nav with all
// 7 sections, top bar with the signed-in user's identity and sign-out. "Dependants" and
// "Caregivers" are real routes (see docs/project-state.md's HEZ-52/53/54/55/56 entry) - every
// other section renders present-but-disabled, so the shell matches the design without claiming
// functionality that doesn't exist yet.
const NAV_SECTIONS = [
  { label: 'Overview', path: undefined },
  { label: 'Caregivers', path: '/caregivers' },
  { label: 'Dependants', path: '/dependants' },
  { label: 'Scheduling', path: '/scheduling' },
  { label: 'Visits', path: undefined },
  { label: 'Alerts', path: undefined },
  { label: 'Compliance', path: undefined },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { identity, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Every /caregivers route is supervisor-only on the backend (requireRole('supervisor') covers
  // the whole router, not just registration - a caregiver can never self-register, confirmed with
  // the user) - disabled here too for a signed-in non-supervisor, rather than only finding out via
  // a failed request, the same "hide what you can't use" treatment Flagged Enrollments/Make
  // Primary/the dependant status field already get elsewhere in this app. Scheduling gets the same
  // treatment: GET /visit-schedules is open to all three roles, but this page's whole purpose is
  // POST/PATCH (create, reschedule, cancel), both supervisor-only per visitSchedules.ts.
  const isSupervisor = identity?.role === 'supervisor';
  const supervisorOnlySections = new Set(['Caregivers', 'Scheduling']);
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
          <div className="app-shell__brand-subtitle">Supervisor Console</div>
        </div>
        <nav className="app-shell__nav">
          {navSections.map((section) => (
            <NavItem
              key={section.label}
              label={section.label}
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
      </aside>
      <div className="app-shell__main">
        <header className="app-shell__topbar">
          <span className="app-shell__user">{identity?.email ?? identity?.sub}</span>
          <button type="button" className="app-shell__sign-out" onClick={signOut}>
            Sign out
          </button>
        </header>
        <main className="app-shell__content">{children}</main>
      </div>
    </div>
  );
}

// The summary a map dot shows for its home (user's layout, 2026-09-26): two columns split by a
// vertical rule - state icons on the left; the dependant's name, a rule across the whole summary,
// then each visit's caregiver and times on the right, with a rule under each visit. Shared by the
// Google and OpenStreetMap versions of the Overview map.

import { Calendar03Icon, Login03Icon, Logout03Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import type { ReactNode } from 'react';
import type { OverviewVisit } from '../api/dashboard';
import type { Home } from './homes';
import { StateIcon } from './StateIcon';
import { formatTime } from './visitStates';
import './HomeSummary.css';

function TimeLine({
  icon,
  label,
  children,
}: {
  icon: IconSvgElement;
  label: string;
  children: ReactNode;
}) {
  return (
    <span className="visits-map__time">
      <HugeiconsIcon
        icon={icon}
        size={14}
        strokeWidth={1.8}
        className="visits-map__time-icon"
        role="img"
        aria-label={label}
      />
      {children}
    </span>
  );
}

// One visit as a row of the summary's two columns: its state icon left of the rule, the caregiver
// and times right of it.
function VisitSummary({ visit, timeZone }: { visit: OverviewVisit; timeZone: string }) {
  const time = (iso: string) => formatTime(iso, timeZone);
  return (
    <>
      <div className="visits-map__icon-cell">
        <StateIcon state={visit.state} />
      </div>
      <div className="visits-map__detail-cell">
        <div className="visits-map__caregiver">{visit.caregiver.fullName}</div>
        {/* Each time behind an icon saying what it is (user request, 2026-09-26): sign-in for
            check-in, sign-out for checkout, a calendar for a scheduled time. */}
        <div className="visits-map__times">
          {visit.checkinAt ? (
            <>
              <TimeLine icon={Login03Icon} label="Checked in">
                {time(visit.checkinAt)}
              </TimeLine>
              <TimeLine icon={Logout03Icon} label="Checked out">
                {visit.checkoutAt ? time(visit.checkoutAt) : 'Not yet'}
              </TimeLine>
            </>
          ) : (
            <TimeLine icon={Calendar03Icon} label="Scheduled">
              {time(visit.scheduledStart)} to {time(visit.scheduledEnd)}
            </TimeLine>
          )}
        </div>
      </div>
    </>
  );
}

export function HomeSummary({ home, timeZone }: { home: Home; timeZone: string }) {
  return (
    <div className="visits-map__tooltip" role="status">
      <div className="visits-map__icon-cell" />
      <div className="visits-map__detail-cell visits-map__dependant">{home.dependantName}</div>
      {home.visits.map((visit) => (
        <VisitSummary key={visit.id} visit={visit} timeZone={timeZone} />
      ))}
    </div>
  );
}

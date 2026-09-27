// A visit in the side panel, wherever a visit is opened (2026-09-27): the Visits table, a
// dependant's or caregiver's visit history, and the Overview's visit list. The side panel replaced
// the visit's own page (user request), so this is the one place a visit's details are shown; a
// link elsewhere uses /visits?visit=<id>, which opens it over the Visits page.

import { useQuery } from '@tanstack/react-query';
import { useApi } from '../api/useApi';
import type { VisitSchedule } from '../api/visitSchedules';
import { SidePanel } from '../design-system/SidePanel';
import { DetailSkeleton } from '../design-system/Skeleton';
import { VisitDetails } from './VisitDetails';
import './VisitPanel.css';

export function VisitPanel({
  visitId,
  visit: known,
  onClose,
}: {
  visitId: string;
  /** The visit, when the opener already has it (a table row), so the panel shows at once. */
  visit?: VisitSchedule;
  onClose: () => void;
}) {
  const { visitSchedules } = useApi();
  const query = useQuery({
    queryKey: ['visit-schedule', visitId],
    queryFn: () => visitSchedules.getVisitSchedule(visitId),
    initialData: known,
  });
  const visit = query.data;

  return (
    <SidePanel
      eyebrow="Visit"
      title={
        visit ? (
          <>
            {visit.caregiverDisplayName} <span className="visit-panel__arrow">→</span>{' '}
            {visit.dependantDisplayName}
          </>
        ) : (
          'Visit'
        )
      }
      onClose={onClose}
    >
      {visit ? (
        <VisitDetails visit={visit} />
      ) : query.isError ? (
        <p className="visit-panel__message">This visit couldn't be loaded.</p>
      ) : (
        <DetailSkeleton rows={5} />
      )}
    </SidePanel>
  );
}

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useApi } from '../api/useApi';
import { VisitDetails } from '../components/VisitDetails';
import { DetailSkeleton } from '../design-system/Skeleton';
import './VisitDetailPage.css';

// A visit's own page, for links and bookmarks (/visits/:id); the Visits table opens the same
// details in a side panel instead (2026-09-27). Both render VisitDetails, so they always match.
export function VisitDetailPage() {
  const { visitId } = useParams<{ visitId: string }>();
  const { visitSchedules } = useApi();
  const visitQuery = useQuery({
    queryKey: ['visit-schedule', visitId],
    queryFn: () => visitSchedules.getVisitSchedule(visitId!),
  });

  if (visitQuery.isLoading) {
    return <DetailSkeleton />;
  }
  if (visitQuery.isError || !visitQuery.data) {
    return <p>Failed to load this visit.</p>;
  }
  const visit = visitQuery.data;

  return (
    <div className="visit-detail-page">
      <h1 className="visit-detail-page__title">
        {visit.caregiverDisplayName} <span className="visit-detail-page__arrow">→</span>{' '}
        {visit.dependantDisplayName}
      </h1>
      <VisitDetails visit={visit} />
    </div>
  );
}

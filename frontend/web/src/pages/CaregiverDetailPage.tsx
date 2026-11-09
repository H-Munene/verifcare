import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useApi } from '../api/useApi';
import { VisitHistoryList } from '../components/VisitHistoryList';
import { VisitStatsTiles } from '../components/VisitStatsTiles';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import './CaregiverDetailPage.css';
import { DetailSkeleton } from '../design-system/Skeleton';
import { Calendar03Icon, Call02Icon, IdIcon } from '@hugeicons/core-free-icons';
import { MetaList } from '../design-system/MetaList';

// The identity header (name/status/meta/edit/activate) above the caregiver's visit history.
/** A calendar date (YYYY-MM-DD) as e.g. "22 Sep 2026"; noon UTC keeps the day in every zone. */
function readableDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function CaregiverDetailPage() {
  const { caregiverId } = useParams<{ caregiverId: string }>();
  const { caregivers } = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const caregiverQuery = useQuery({
    queryKey: ['caregiver', caregiverId],
    queryFn: () => caregivers.getCaregiver(caregiverId!),
  });

  const statsQuery = useQuery({
    queryKey: ['caregiver', caregiverId, 'stats'],
    queryFn: () => caregivers.getCaregiverStats(caregiverId!),
  });

  const setActiveMutation = useMutation({
    mutationFn: (active: boolean) => caregivers.updateCaregiver(caregiverId!, { active }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['caregiver', caregiverId] });
      void queryClient.invalidateQueries({ queryKey: ['caregivers'] });
    },
  });

  if (caregiverQuery.isLoading) {
    return <DetailSkeleton />;
  }
  if (caregiverQuery.isError || !caregiverQuery.data) {
    return <p>Failed to load this caregiver.</p>;
  }
  const caregiver = caregiverQuery.data;

  return (
    <div>
      <div className="caregiver-detail__header">
        <div>
          <div className="caregiver-detail__name-row">
            <h1 className="caregiver-detail__name">{caregiver.fullName}</h1>
            <Badge tone={caregiver.active ? 'success' : 'neutral'}>
              {caregiver.active ? 'Active' : 'Inactive'}
            </Badge>
          </div>
          <MetaList
            items={[
              { icon: IdIcon, children: caregiver.employeeNumber ?? 'No employee number' },
              { icon: Call02Icon, children: caregiver.phoneNumber ?? 'No phone number' },
              {
                icon: Calendar03Icon,
                children: caregiver.hireDate
                  ? `Hired ${readableDate(caregiver.hireDate)}`
                  : 'Hire date not recorded',
              },
            ]}
          />
        </div>
        <Button
          variant="primary"
          onClick={() => {
            void navigate(`/caregivers/${caregiver.userId}/edit`);
          }}
        >
          Edit Caregiver
        </Button>
      </div>

      <VisitStatsTiles
        stats={statsQuery.data}
        isLoading={statsQuery.isLoading}
        isError={statsQuery.isError}
        perspective="caregiver"
      />

      <div className="caregiver-detail__tab-panel">
        <VisitHistoryList caregiverId={caregiver.userId} />
      </div>

      {setActiveMutation.error ? (
        <div className="caregiver-detail__error">
          {setActiveMutation.error instanceof ApiError
            ? (setActiveMutation.error.problem.detail ?? setActiveMutation.error.problem.title)
            : 'Something went wrong.'}
        </div>
      ) : null}

      <div className="caregiver-detail__actions">
        <Button
          onClick={() => setActiveMutation.mutate(!caregiver.active)}
          disabled={setActiveMutation.isPending}
        >
          {caregiver.active ? 'Deactivate' : 'Reactivate'}
        </Button>
      </div>
    </div>
  );
}

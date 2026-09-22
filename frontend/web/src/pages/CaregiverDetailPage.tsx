import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useApi } from '../api/useApi';
import { BiometricEnrollmentSection } from '../components/BiometricEnrollmentSection';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import './CaregiverDetailPage.css';

// No Visit History section here - deliberately out of scope (matches the wireframe and HEZ-54's
// own stated scope; there's no visit-history UI anywhere yet, same reasoning as
// DependantDetailPage's own Visit History empty-state).
export function CaregiverDetailPage() {
  const { caregiverId } = useParams<{ caregiverId: string }>();
  const { caregivers } = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const caregiverQuery = useQuery({
    queryKey: ['caregiver', caregiverId],
    queryFn: () => caregivers.getCaregiver(caregiverId!),
  });

  // The backend runs biometric-enrollment offboarding cleanup on active:false itself - nothing
  // extra needed here beyond calling PATCH and refreshing.
  const setActiveMutation = useMutation({
    mutationFn: (active: boolean) => caregivers.updateCaregiver(caregiverId!, { active }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['caregiver', caregiverId] });
      void queryClient.invalidateQueries({ queryKey: ['caregivers'] });
    },
  });

  if (caregiverQuery.isLoading) {
    return <p>Loading...</p>;
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
          <div className="caregiver-detail__meta">
            {caregiver.employeeNumber ?? 'No employee #'} · {caregiver.phoneNumber ?? 'No phone'} ·
            Hired {caregiver.hireDate ?? 'unknown'}
          </div>
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

      <BiometricEnrollmentSection subjectType="caregiver" subjectId={caregiver.userId} />

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

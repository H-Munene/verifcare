import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useApi } from '../api/useApi';
import { BiometricEnrollmentSection } from '../components/BiometricEnrollmentSection';
import { VisitHistoryList } from '../components/VisitHistoryList';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { Tabs } from '../design-system/Tabs';
import './CaregiverDetailPage.css';

type DetailTab = 'enrollment' | 'visits';

const TABS = [
  { id: 'enrollment' as const, label: 'Enrollment' },
  { id: 'visits' as const, label: 'Visit History' },
];

// Restructured into tabs (2026-09-23, user request, matching temp_images/tabs_ui.PNG) - the
// identity header (name/status/meta/edit/activate) stays outside the tabs since it applies to the
// whole page. Visit History is new here: this page had none at all before (matches the wireframe
// and HEZ-54's own stated scope at the time, since there was no real visit data to show), now
// backed by the same VisitHistoryList DependantDetailPage's own identical tab uses.
export function CaregiverDetailPage() {
  const { caregiverId } = useParams<{ caregiverId: string }>();
  const { caregivers } = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<DetailTab>('enrollment');

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

      <Tabs tabs={TABS} activeTab={activeTab} onChange={(id) => setActiveTab(id as DetailTab)} />

      <div className="caregiver-detail__tab-panel">
        {activeTab === 'enrollment' ? (
          <BiometricEnrollmentSection subjectType="caregiver" subjectId={caregiver.userId} />
        ) : null}
        {activeTab === 'visits' ? <VisitHistoryList caregiverId={caregiver.userId} /> : null}
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

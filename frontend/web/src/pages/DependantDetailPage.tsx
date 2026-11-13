import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../api/useApi';
import { FamilyMembersTable } from '../components/FamilyMembersTable';
import {
  FamilyMemberResolver,
  type FamilyMemberSelection,
} from '../components/FamilyMemberResolver';
import { VisitHistoryList } from '../components/VisitHistoryList';
import { VisitStatsTiles } from '../components/VisitStatsTiles';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { Input } from '../design-system/Input';
import { Modal } from '../design-system/Modal';
import { Switch } from '../design-system/Switch';
import { Tabs } from '../design-system/Tabs';
import './DependantDetailPage.css';
import { DetailSkeleton } from '../design-system/Skeleton';
import { BirthdayCakeIcon, Location01Icon, UserIcon } from '@hugeicons/core-free-icons';
import { MetaList } from '../design-system/MetaList';
import { LoadError } from '../design-system/LoadError';

type DetailTab = 'family' | 'visits';

const TABS = [
  { id: 'family' as const, label: 'Family' },
  { id: 'visits' as const, label: 'Visit History' },
];

// Wireframe page 6 (Dependant Detail), restructured into tabs (2026-09-23, user request, matching
// temp_images/tabs_ui.PNG) - the identity header (name/status/meta/actions) stays outside the tabs
// since it applies to the whole page, not to any one section. Visit History is real now (VisitHistoryList, shared with
// CaregiverDetailPage's identical tab), since HEZ-32/HEZ-42's visit-schedule/verification-audit
// endpoints exist and are already consumed by VisitsPage/VisitDetailPage.
/** A calendar date (YYYY-MM-DD) as e.g. "22 Sep 2026"; noon UTC keeps the day in every zone. */
function readableDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Whole years since a YYYY-MM-DD birth date. */
function ageInYears(dob: string): number {
  const [y = 0, m = 1, d = 1] = dob.split('-').map(Number);
  const now = new Date();
  const hadBirthday = now.getMonth() + 1 > m || (now.getMonth() + 1 === m && now.getDate() >= d);
  return now.getFullYear() - y - (hadBirthday ? 0 : 1);
}

export function DependantDetailPage() {
  const { dependantId } = useParams<{ dependantId: string }>();
  const { dependants } = useApi();
  const navigate = useNavigate();
  const [addingMember, setAddingMember] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>('family');

  const dependantQuery = useQuery({
    queryKey: ['dependant', dependantId],
    queryFn: () => dependants.getDependant(dependantId!),
  });
  const statsQuery = useQuery({
    queryKey: ['dependant', dependantId, 'stats'],
    queryFn: () => dependants.getDependantStats(dependantId!),
  });
  const familyMembersQuery = useQuery({
    queryKey: ['dependant', dependantId, 'family-members'],
    queryFn: () => dependants.listFamilyMembers(dependantId!),
    enabled: activeTab === 'family',
  });

  if (dependantQuery.isLoading) {
    return <DetailSkeleton />;
  }
  if (dependantQuery.isError || !dependantQuery.data) {
    return <LoadError what="this dependant" onRetry={() => void dependantQuery.refetch()} />;
  }
  const dependant = dependantQuery.data;

  return (
    <div>
      <div className="dependant-detail__header">
        <div>
          <div className="dependant-detail__name-row">
            <h1 className="dependant-detail__name">{dependant.fullName}</h1>
            <Badge tone={dependant.status === 'active' ? 'success' : 'neutral'}>
              {dependant.status}
            </Badge>
          </div>
          <MetaList
            items={[
              {
                icon: UserIcon,
                children: dependant.gender
                  ? dependant.gender.charAt(0).toUpperCase() + dependant.gender.slice(1)
                  : 'Gender not recorded',
              },
              {
                icon: BirthdayCakeIcon,
                children: `Born ${readableDate(dependant.dob)} (${ageInYears(dependant.dob)} years)`,
              },
              {
                icon: Location01Icon,
                children: `${dependant.geofenceRadiusMeters} m check-in radius`,
                title: 'How close to the home a caregiver must be to check in or out',
              },
            ]}
          />
        </div>
        <div className="dependant-detail__header-actions">
          <Button
            onClick={() => {
              void navigate(`/dependants/${dependant.id}/care-plan`);
            }}
          >
            Care Plan
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void navigate(`/dependants/${dependant.id}/edit`);
            }}
          >
            Edit Dependant
          </Button>
        </div>
      </div>

      <VisitStatsTiles
        stats={statsQuery.data}
        isLoading={statsQuery.isLoading}
        isError={statsQuery.isError}
        onRetry={() => void statsQuery.refetch()}
        perspective="dependant"
      />

      <Tabs tabs={TABS} activeTab={activeTab} onChange={(id) => setActiveTab(id as DetailTab)} />

      <div className="dependant-detail__tab-panel">
        {activeTab === 'family' ? (
          <section className="dependant-detail__section">
            <div className="dependant-detail__section-header">
              <h2 className="dependant-detail__section-title">Family Members</h2>
              <Button onClick={() => setAddingMember(true)}>+ Add Family Member</Button>
            </div>
            <FamilyMembersTable
              dependantId={dependant.id}
              dependantName={dependant.fullName}
              members={familyMembersQuery.data}
              isLoading={familyMembersQuery.isLoading}
              isError={familyMembersQuery.isError}
              onRetry={() => void familyMembersQuery.refetch()}
            />
          </section>
        ) : null}

        {activeTab === 'visits' ? <VisitHistoryList dependantId={dependant.id} /> : null}
      </div>

      {addingMember ? (
        <AddFamilyMemberModal dependantId={dependant.id} onClose={() => setAddingMember(false)} />
      ) : null}
    </div>
  );
}

function AddFamilyMemberModal({
  dependantId,
  onClose,
}: {
  dependantId: string;
  onClose: () => void;
}) {
  const { dependants } = useApi();
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<FamilyMemberSelection | null>(null);
  const [relationship, setRelationship] = useState('');
  const [isPrimaryContact, setIsPrimaryContact] = useState(false);

  const mutation = useMutation({
    mutationFn: () => {
      if (!selection) {
        throw new Error('No family member selected.');
      }
      return dependants.addFamilyMember(dependantId, {
        ...selection,
        relationship: relationship || undefined,
        isPrimaryContact,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['dependant', dependantId, 'family-members'],
      });
      onClose();
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <Modal title="Add Family Member" onClose={onClose}>
      <form className="dependant-detail__modal-form" onSubmit={handleSubmit} autoComplete="off">
        <FamilyMemberResolver selection={selection} onSelect={setSelection} />
        <Input
          id="memberRelationship"
          label="Relationship"
          value={relationship}
          onChange={(e) => setRelationship(e.target.value)}
        />
        <Switch
          checked={isPrimaryContact}
          onChange={setIsPrimaryContact}
          label="Make this the primary contact"
        />
        <div className="dependant-detail__modal-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={mutation.isPending || !selection}>
            {mutation.isPending ? 'Adding...' : 'Add'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

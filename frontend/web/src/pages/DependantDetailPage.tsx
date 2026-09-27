import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import type { DependantFamilyMember } from '../api/dependants';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { BiometricEnrollmentSection } from '../components/BiometricEnrollmentSection';
import {
  FamilyMemberResolver,
  type FamilyMemberSelection,
} from '../components/FamilyMemberResolver';
import { VisitHistoryList } from '../components/VisitHistoryList';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { Input } from '../design-system/Input';
import { Modal } from '../design-system/Modal';
import { Switch } from '../design-system/Switch';
import { Tabs } from '../design-system/Tabs';
import { Tag } from '../design-system/Tag';
import './DependantDetailPage.css';
import { DetailSkeleton } from '../design-system/Skeleton';

type DetailTab = 'family' | 'enrollment' | 'visits' | 'cognitive';

const TABS = [
  { id: 'family' as const, label: 'Family' },
  { id: 'enrollment' as const, label: 'Enrollment' },
  { id: 'visits' as const, label: 'Visit History' },
  { id: 'cognitive' as const, label: 'Cognitive Trend' },
];

// Wireframe page 6 (Dependant Detail), restructured into tabs (2026-09-23, user request, matching
// temp_images/tabs_ui.PNG) - the identity header (name/status/meta/actions) stays outside the tabs
// since it applies to the whole page, not to any one section. Cognitive Trend still renders as an
// honest empty state - the audio/cognitive-risk pipeline doesn't exist yet, so there is genuinely
// nothing to show there; Visit History is real now (VisitHistoryList, shared with
// CaregiverDetailPage's identical tab), since HEZ-32/HEZ-42's visit-schedule/verification-audit
// endpoints exist and are already consumed by VisitsPage/VisitDetailPage.
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
  const familyMembersQuery = useQuery({
    queryKey: ['dependant', dependantId, 'family-members'],
    queryFn: () => dependants.listFamilyMembers(dependantId!),
    enabled: activeTab === 'family',
  });

  if (dependantQuery.isLoading) {
    return <DetailSkeleton />;
  }
  if (dependantQuery.isError || !dependantQuery.data) {
    return <p>Failed to load this dependant.</p>;
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
          <div className="dependant-detail__meta">
            {dependant.gender ?? 'Unspecified'} · DOB {dependant.dob} · Geofence radius{' '}
            {dependant.geofenceRadiusMeters}m
          </div>
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

      <Tabs tabs={TABS} activeTab={activeTab} onChange={(id) => setActiveTab(id as DetailTab)} />

      <div className="dependant-detail__tab-panel">
        {activeTab === 'family' ? (
          <section className="dependant-detail__section">
            <div className="dependant-detail__section-header">
              <h2 className="dependant-detail__section-title">Family Members</h2>
              <Button onClick={() => setAddingMember(true)}>+ Add Family Member</Button>
            </div>
            {familyMembersQuery.data?.length ? (
              <div className="ds-card">
                {familyMembersQuery.data.map((member) => (
                  <FamilyMemberRow
                    key={member.familyMemberUserId}
                    dependantId={dependant.id}
                    member={member}
                  />
                ))}
              </div>
            ) : (
              <p className="dependant-detail__empty">No family members linked yet.</p>
            )}
          </section>
        ) : null}

        {activeTab === 'enrollment' ? (
          <BiometricEnrollmentSection subjectType="dependant" subjectId={dependant.id} />
        ) : null}

        {activeTab === 'visits' ? <VisitHistoryList dependantId={dependant.id} /> : null}

        {activeTab === 'cognitive' ? (
          <p className="dependant-detail__empty">
            No cognitive-risk data yet - the acoustic model service has not been built yet.
          </p>
        ) : null}
      </div>

      {addingMember ? (
        <AddFamilyMemberModal dependantId={dependant.id} onClose={() => setAddingMember(false)} />
      ) : null}
    </div>
  );
}

const ID_TYPE_LABELS: Record<'national_id' | 'passport', string> = {
  national_id: 'National ID',
  passport: 'Passport',
};

// One linked family member. The name comes with the list itself (it used to be a GET /users/{id}
// per row). The row expands to the member's registration details (2026-09-26, user request).
function FamilyMemberRow({
  dependantId,
  member,
}: {
  dependantId: string;
  member: DependantFamilyMember;
}) {
  const { dependants } = useApi();
  const { identity } = useAuth();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const detailsId = `family-member-details-${member.familyMemberUserId}`;

  // PATCH .../family-members/{userId} is supervisor-only (HEZ-30) - matches this app's exclusive
  // supervisor use case, but still gated on the caller's actual role rather than assumed, the same
  // way RegisterDependantPage gates the status field.
  const makePrimaryMutation = useMutation({
    mutationFn: () =>
      dependants.updateFamilyMember(dependantId, member.familyMemberUserId, {
        isPrimaryContact: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['dependant', dependantId, 'family-members'],
      });
    },
  });

  const identityDocument =
    member.idType && member.idNumber
      ? `${ID_TYPE_LABELS[member.idType]} · ${member.idNumber}`
      : 'Not recorded';
  const details: [string, string][] = [
    ['Email', member.email ?? 'Not recorded'],
    ['Phone', member.phoneNumber ?? 'Not recorded'],
    ['ID document', identityDocument],
    ['Relationship', member.relationship ?? 'Not set'],
    ['Primary contact', member.isPrimaryContact ? 'Yes' : 'No'],
    ['Added by', member.addedByName ?? 'Unknown'],
    [
      'Linked on',
      new Date(member.createdAt).toLocaleDateString('en-KE', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
    ],
  ];

  return (
    <div className="dependant-detail__member">
      <div className="ds-row-store">
        <button
          type="button"
          className="dependant-detail__member-toggle"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((open) => !open)}
        >
          <span
            className={`dependant-detail__member-chevron${expanded ? ' dependant-detail__member-chevron--open' : ''}`}
            aria-hidden="true"
          >
            ›
          </span>
          <span>
            <span className="ds-row-store__title">{member.fullName}</span>
            <span className="ds-row-store__caption">
              {member.relationship ?? 'Relationship not set'}
            </span>
          </span>
        </button>
        {member.isPrimaryContact ? (
          <Tag>Primary contact</Tag>
        ) : identity?.role === 'supervisor' ? (
          <Button
            onClick={() => makePrimaryMutation.mutate()}
            disabled={makePrimaryMutation.isPending}
          >
            Make primary
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <dl id={detailsId} className="dependant-detail__member-details">
          {details.map(([label, value]) => (
            <div key={label} className="dependant-detail__member-detail">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
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
        {mutation.error ? (
          <div className="dependant-detail__modal-error">
            {mutation.error instanceof ApiError
              ? (mutation.error.problem.detail ?? mutation.error.problem.title)
              : 'Something went wrong.'}
          </div>
        ) : null}
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

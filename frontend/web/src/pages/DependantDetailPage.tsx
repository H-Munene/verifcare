import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import type { DependantFamilyMember } from '../api/dependants';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import {
  FamilyMemberResolver,
  type FamilyMemberSelection,
} from '../components/FamilyMemberResolver';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { Input } from '../design-system/Input';
import { Modal } from '../design-system/Modal';
import { Switch } from '../design-system/Switch';
import { Tag } from '../design-system/Tag';
import './DependantDetailPage.css';

// Visit History and Cognitive Trend are empty states until scheduling and audio analysis exist.
export function DependantDetailPage() {
  const { dependantId } = useParams<{ dependantId: string }>();
  const { dependants } = useApi();
  const navigate = useNavigate();
  const [addingMember, setAddingMember] = useState(false);

  const dependantQuery = useQuery({
    queryKey: ['dependant', dependantId],
    queryFn: () => dependants.getDependant(dependantId!),
  });
  const familyMembersQuery = useQuery({
    queryKey: ['dependant', dependantId, 'family-members'],
    queryFn: () => dependants.listFamilyMembers(dependantId!),
  });

  if (dependantQuery.isLoading) {
    return <p>Loading...</p>;
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
        <Button
          variant="primary"
          onClick={() => {
            void navigate(`/dependants/${dependant.id}/edit`);
          }}
        >
          Edit Dependant
        </Button>
      </div>

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

      <section className="dependant-detail__section">
        <h2 className="dependant-detail__section-title">Visit History</h2>
        <p className="dependant-detail__empty">
          No visits yet - visit scheduling has not been built yet.
        </p>
      </section>

      <section className="dependant-detail__section">
        <h2 className="dependant-detail__section-title">Cognitive Trend</h2>
        <p className="dependant-detail__empty">
          No cognitive-risk data yet - the acoustic model service has not been built yet.
        </p>
      </section>

      {addingMember ? (
        <AddFamilyMemberModal dependantId={dependant.id} onClose={() => setAddingMember(false)} />
      ) : null}
    </div>
  );
}

// The family-members endpoint only returns user ids, so names are fetched via GET /users/{id}.
function FamilyMemberRow({
  dependantId,
  member,
}: {
  dependantId: string;
  member: DependantFamilyMember;
}) {
  const { users, dependants } = useApi();
  const { identity } = useAuth();
  const queryClient = useQueryClient();
  const userQuery = useQuery({
    queryKey: ['user', member.familyMemberUserId],
    queryFn: () => users.getUser(member.familyMemberUserId),
  });

  // Editing a family-member link is supervisor-only.
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

  return (
    <div className="ds-row-store">
      <div>
        <div className="ds-row-store__title">
          {userQuery.data?.fullName ??
            (userQuery.isLoading ? 'Loading...' : member.familyMemberUserId)}
        </div>
        <div className="ds-row-store__caption">{member.relationship ?? 'Relationship not set'}</div>
      </div>
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

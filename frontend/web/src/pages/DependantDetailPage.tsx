import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { BiometricEnrollment } from '../api/biometricEnrollments';
import { uploadFileToPresignedUrl } from '../api/biometricEnrollments';
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

const IMAGE_ORDER_SLOTS = [1, 2, 3] as const;

// GET /biometric-enrollments returns every non-deleted row (active, superseded, and flagged) for
// the subject - this picks the one row worth showing per imageOrder slot: an active row if one
// exists, otherwise a flagged one awaiting review, otherwise (a superseded leftover with nothing
// newer yet) whatever's there.
function enrollmentForSlot(
  enrollments: BiometricEnrollment[] | undefined,
  imageOrder: number,
): BiometricEnrollment | undefined {
  const forSlot = enrollments?.filter((e) => e.imageOrder === imageOrder) ?? [];
  return (
    forSlot.find((e) => e.status === 'active') ??
    forSlot.find((e) => e.status === 'flagged') ??
    forSlot[0]
  );
}

// Wireframe page 6 (Dependant Detail). Visit History and Cognitive Trend render as honest empty
// states rather than faked data - HEZ-32 (visit scheduling) and the audio/cognitive-risk pipeline
// don't exist yet, so there is genuinely nothing to show there.
export function DependantDetailPage() {
  const { dependantId } = useParams<{ dependantId: string }>();
  const { dependants, biometricEnrollments } = useApi();
  const navigate = useNavigate();
  const [addingMember, setAddingMember] = useState(false);
  const [uploadingImageOrder, setUploadingImageOrder] = useState<number | null>(null);

  const dependantQuery = useQuery({
    queryKey: ['dependant', dependantId],
    queryFn: () => dependants.getDependant(dependantId!),
  });
  const familyMembersQuery = useQuery({
    queryKey: ['dependant', dependantId, 'family-members'],
    queryFn: () => dependants.listFamilyMembers(dependantId!),
  });
  const enrollmentsQuery = useQuery({
    queryKey: ['dependant', dependantId, 'biometric-enrollments'],
    queryFn: () => biometricEnrollments.listEnrollments('dependant', dependantId!),
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
        <div className="dependant-detail__section-header">
          <h2 className="dependant-detail__section-title">Biometric Enrollment</h2>
        </div>
        <div className="ds-card">
          {IMAGE_ORDER_SLOTS.map((imageOrder) => (
            <EnrollmentSlotRow
              key={imageOrder}
              imageOrder={imageOrder}
              enrollment={enrollmentForSlot(enrollmentsQuery.data, imageOrder)}
              onUpload={() => setUploadingImageOrder(imageOrder)}
            />
          ))}
        </div>
        <p className="dependant-detail__empty">
          A face flagged as a possible duplicate is reviewed on the{' '}
          <Link to="/flagged-enrollments">Flagged Enrollments</Link> page, not here.
        </p>
      </section>

      <section className="dependant-detail__section">
        <h2 className="dependant-detail__section-title">Visit History</h2>
        <p className="dependant-detail__empty">
          No visits yet - visit scheduling has not been built yet (Linear HEZ-32).
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
      {uploadingImageOrder ? (
        <UploadEnrollmentModal
          dependantId={dependant.id}
          imageOrder={uploadingImageOrder}
          onClose={() => setUploadingImageOrder(null)}
        />
      ) : null}
    </div>
  );
}

function EnrollmentSlotRow({
  imageOrder,
  enrollment,
  onUpload,
}: {
  imageOrder: number;
  enrollment: BiometricEnrollment | undefined;
  onUpload: () => void;
}) {
  return (
    <div className="ds-row-store">
      <div>
        <div className="ds-row-store__title">Image {imageOrder}</div>
        <div className="ds-row-store__caption">
          {enrollment
            ? `Quality score: ${enrollment.qualityScore?.toFixed(1) ?? 'n/a'}`
            : 'Not yet uploaded'}
          {enrollment?.status === 'flagged' ? (
            <>
              {' '}
              · matched a {enrollment.matchedSubjectType} at{' '}
              {enrollment.matchedSimilarity?.toFixed(1)}% similarity
            </>
          ) : null}
        </div>
      </div>
      {enrollment ? (
        <Badge
          tone={
            enrollment.status === 'active'
              ? 'success'
              : enrollment.status === 'flagged'
                ? 'danger'
                : 'neutral'
          }
        >
          {enrollment.status}
        </Badge>
      ) : null}
      <Button onClick={onUpload}>{enrollment ? 'Re-upload' : 'Upload'}</Button>
    </div>
  );
}

const ACCEPTED_CONTENT_TYPES = ['image/jpeg', 'image/png'] as const;

function UploadEnrollmentModal({
  dependantId,
  imageOrder,
  onClose,
}: {
  dependantId: string;
  imageOrder: number;
  onClose: () => void;
}) {
  const { biometricEnrollments } = useApi();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<BiometricEnrollment | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!file) {
        throw new Error('Choose a photo first.');
      }
      if (!ACCEPTED_CONTENT_TYPES.includes(file.type as (typeof ACCEPTED_CONTENT_TYPES)[number])) {
        throw new Error('Only JPEG or PNG images are accepted.');
      }
      const contentType = file.type as 'image/jpeg' | 'image/png';
      const presigned = await biometricEnrollments.createUploadUrl({
        subjectType: 'dependant',
        subjectId: dependantId,
        imageOrder,
        contentType,
      });
      await uploadFileToPresignedUrl(presigned.uploadUrl, file);
      return biometricEnrollments.confirmEnrollment({
        subjectType: 'dependant',
        subjectId: dependantId,
        s3Key: presigned.s3Key,
        imageOrder,
      });
    },
    onSuccess: (enrollment) => {
      setResult(enrollment);
      void queryClient.invalidateQueries({
        queryKey: ['dependant', dependantId, 'biometric-enrollments'],
      });
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <Modal title={`Upload Photo (Image ${imageOrder})`} onClose={onClose}>
      {result ? (
        <div className="dependant-detail__modal-form">
          {result.status === 'flagged' ? (
            <p>
              This photo matched an already-enrolled {result.matchedSubjectType} at{' '}
              {result.matchedSimilarity?.toFixed(1)}% similarity - it's been flagged for a
              supervisor to review on the <Link to="/flagged-enrollments">Flagged Enrollments</Link>{' '}
              page, and hasn't been activated.
            </p>
          ) : (
            <p>
              Uploaded and activated - quality score {result.qualityScore?.toFixed(1) ?? 'n/a'}.
            </p>
          )}
          <div className="dependant-detail__modal-actions">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form className="dependant-detail__modal-form" onSubmit={handleSubmit}>
          <Input
            id="enrollmentFile"
            type="file"
            label="Photo (JPEG or PNG)"
            accept="image/jpeg,image/png"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {mutation.error ? (
            <div className="dependant-detail__modal-error">
              {mutation.error instanceof ApiError
                ? (mutation.error.problem.detail ?? mutation.error.problem.title)
                : mutation.error instanceof Error
                  ? mutation.error.message
                  : 'Something went wrong.'}
            </div>
          ) : null}
          <div className="dependant-detail__modal-actions">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={mutation.isPending || !file}>
              {mutation.isPending ? 'Uploading...' : 'Upload'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// The family-members endpoint only returns familyMemberUserId (an internal UUID), not a display
// name (matches backend/openapi.yaml's DependantFamilyMember schema exactly) - resolved here via
// GET /users/{id} (supervisor-only, which matches this app's exclusive supervisor use case)
// instead of showing the raw UUID.
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

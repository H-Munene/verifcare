import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { BiometricEnrollment, SubjectType } from '../api/biometricEnrollments';
import { uploadFileToPresignedUrl } from '../api/biometricEnrollments';
import { ApiError } from '../api/client';
import { useApi } from '../api/useApi';
import { Badge } from '../design-system/Badge';
import { Button } from '../design-system/Button';
import { Input } from '../design-system/Input';
import { Modal } from '../design-system/Modal';
import './BiometricEnrollmentSection.css';

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

// Extracted out of DependantDetailPage.tsx (originally the only caller) so CaregiverDetailPage
// can reuse it unchanged - already subject-agnostic underneath (biometricEnrollments.ts's
// SubjectType), this is a pure extraction with no behavior change.
export function BiometricEnrollmentSection({
  subjectType,
  subjectId,
}: {
  subjectType: SubjectType;
  subjectId: string;
}) {
  const { biometricEnrollments } = useApi();
  const [uploadingImageOrder, setUploadingImageOrder] = useState<number | null>(null);

  const enrollmentsQuery = useQuery({
    queryKey: [subjectType, subjectId, 'biometric-enrollments'],
    queryFn: () => biometricEnrollments.listEnrollments(subjectType, subjectId),
  });

  return (
    <section className="biometric-enrollment-section">
      <div className="biometric-enrollment-section__header">
        <h2 className="biometric-enrollment-section__title">Biometric Enrollment</h2>
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
      <p className="biometric-enrollment-section__empty">
        A face flagged as a possible duplicate is reviewed on the{' '}
        <Link to="/flagged-enrollments">Flagged Enrollments</Link> page, not here.
      </p>
      {uploadingImageOrder ? (
        <UploadEnrollmentModal
          subjectType={subjectType}
          subjectId={subjectId}
          imageOrder={uploadingImageOrder}
          onClose={() => setUploadingImageOrder(null)}
        />
      ) : null}
    </section>
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
  subjectType,
  subjectId,
  imageOrder,
  onClose,
}: {
  subjectType: SubjectType;
  subjectId: string;
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
        subjectType,
        subjectId,
        imageOrder,
        contentType,
      });
      await uploadFileToPresignedUrl(presigned.uploadUrl, file);
      return biometricEnrollments.confirmEnrollment({
        subjectType,
        subjectId,
        s3Key: presigned.s3Key,
        imageOrder,
      });
    },
    onSuccess: (enrollment) => {
      setResult(enrollment);
      void queryClient.invalidateQueries({
        queryKey: [subjectType, subjectId, 'biometric-enrollments'],
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
        <div className="biometric-enrollment-section__modal-form">
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
          <div className="biometric-enrollment-section__modal-actions">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form className="biometric-enrollment-section__modal-form" onSubmit={handleSubmit}>
          <Input
            id="enrollmentFile"
            type="file"
            label="Photo (JPEG or PNG)"
            accept="image/jpeg,image/png"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {mutation.error ? (
            <div className="biometric-enrollment-section__modal-error">
              {mutation.error instanceof ApiError
                ? (mutation.error.problem.detail ?? mutation.error.problem.title)
                : mutation.error instanceof Error
                  ? mutation.error.message
                  : 'Something went wrong.'}
            </div>
          ) : null}
          <div className="biometric-enrollment-section__modal-actions">
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

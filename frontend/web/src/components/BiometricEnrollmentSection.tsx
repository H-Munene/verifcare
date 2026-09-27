import { Delete02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ENROLLMENT_CONTENT_TYPES,
  ENROLLMENT_MAX_BYTES,
  type BiometricEnrollment,
  type SubjectType,
} from '../api/biometricEnrollments';
import { useApi } from '../api/useApi';
import { Button } from '../design-system/Button';
import { ImageDropzone } from '../design-system/ImageDropzone';
import { Modal } from '../design-system/Modal';
import { Skeleton, SkeletonRegion } from '../design-system/Skeleton';
import { useEnrollPhoto } from '../hooks/useEnrollPhoto';
import { EnrollmentOutcome } from './EnrollmentOutcome';
import './BiometricEnrollmentSection.css';

// The Enrollment tab on the dependant and caregiver pages: the one check-in photo (2026-09-27,
// user decision - the POC needs one photo per person, not the old three image slots). A 130px
// square shows the photo in use, or a grey "No image uploaded" square with Upload beside it.
//
// There's deliberately no plain delete. Check-in matches the live face against this photo, so
// removing it would leave the person unverifiable; the bin instead explains that and asks for the
// replacement, and Save stays disabled until one is chosen. The server retires the old photo only
// when the new one activates (a replacement flagged as a likely duplicate leaves the old one in
// use until a supervisor approves it), so there is never a moment with no photo.

const DATE_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

export function BiometricEnrollmentSection({
  subjectType,
  subjectId,
  subjectName,
}: {
  subjectType: SubjectType;
  subjectId: string;
  subjectName: string;
}) {
  const { biometricEnrollments } = useApi();
  const [dialog, setDialog] = useState<'upload' | 'replace' | null>(null);

  const enrollmentsQuery = useQuery({
    queryKey: [subjectType, subjectId, 'biometric-enrollments'],
    queryFn: () => biometricEnrollments.listEnrollments(subjectType, subjectId),
  });
  const active = enrollmentsQuery.data?.find((e) => e.status === 'active');
  const flagged = enrollmentsQuery.data?.find((e) => e.status === 'flagged');
  // What the square shows: the photo check-in uses, else one waiting for review.
  const shown = active ?? flagged;

  return (
    <section className="biometric-enrollment-section">
      <div className="biometric-enrollment-section__header">
        <h2 className="biometric-enrollment-section__title">Check-in photo</h2>
      </div>
      <p className="biometric-enrollment-section__intro">
        Check-in compares the face at the door with this photo to confirm it&rsquo;s {subjectName}.
      </p>

      {enrollmentsQuery.isLoading ? (
        <SkeletonRegion label="Loading the photo" className="biometric-enrollment-section__row">
          <Skeleton width={130} height={130} radius={12} />
          <div className="biometric-enrollment-section__info">
            <Skeleton width={160} height={14} />
            <Skeleton width={220} height={12} />
          </div>
        </SkeletonRegion>
      ) : enrollmentsQuery.isError ? (
        <p className="biometric-enrollment-section__note">The photo couldn&rsquo;t be loaded.</p>
      ) : (
        <div className="biometric-enrollment-section__row">
          {shown ? (
            <img
              className="biometric-enrollment-section__photo"
              src={shown.imageUrl}
              alt={`Check-in photo of ${subjectName}`}
            />
          ) : (
            <div className="biometric-enrollment-section__photo biometric-enrollment-section__photo--empty">
              No image uploaded
            </div>
          )}

          <div className="biometric-enrollment-section__info">
            <PhotoStatus active={active} flagged={flagged} />
            {shown ? (
              <button
                type="button"
                className="biometric-enrollment-section__remove"
                aria-label="Delete photo"
                title="Delete photo"
                onClick={() => setDialog('replace')}
              >
                <HugeiconsIcon icon={Delete02Icon} size={18} strokeWidth={1.7} aria-hidden />
              </button>
            ) : (
              <Button onClick={() => setDialog('upload')}>Upload</Button>
            )}
          </div>
        </div>
      )}

      {dialog ? (
        <PhotoDialog
          mode={dialog}
          subjectType={subjectType}
          subjectId={subjectId}
          subjectName={subjectName}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </section>
  );
}

function PhotoStatus({
  active,
  flagged,
}: {
  active: BiometricEnrollment | undefined;
  flagged: BiometricEnrollment | undefined;
}) {
  if (!active && !flagged) {
    return (
      <div>
        <div className="biometric-enrollment-section__status">No photo yet</div>
        <div className="biometric-enrollment-section__note">
          Visits can&rsquo;t be scheduled until there&rsquo;s a photo check-in can use.
        </div>
      </div>
    );
  }
  if (!active && flagged) {
    return (
      <div>
        <div className="biometric-enrollment-section__status biometric-enrollment-section__status--review">
          Waiting for review
        </div>
        <div className="biometric-enrollment-section__note">
          Waiting for review on the <Link to="/reviews">Reviews</Link> page - it looks like an
          already-enrolled {flagged.matchedSubjectType}. Check-in can&rsquo;t use it until
          it&rsquo;s approved.
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="biometric-enrollment-section__status">In use for check-in</div>
      <div className="biometric-enrollment-section__note">
        Added {new Date(active!.enrolledAt).toLocaleDateString('en-KE', DATE_FORMAT)}
        {active!.qualityScore !== null ? ` · quality score ${active!.qualityScore.toFixed(1)}` : ''}
      </div>
      {flagged ? (
        <div className="biometric-enrollment-section__note">
          A replacement is waiting for review on the <Link to="/reviews">Reviews</Link> page - it
          looks like an already-enrolled {flagged.matchedSubjectType}.
        </div>
      ) : null}
    </div>
  );
}

// Upload (no photo yet) and replace (the bin) share one dialog; replace leads with why the photo
// can only go once a new one is chosen.
function PhotoDialog({
  mode,
  subjectType,
  subjectId,
  subjectName,
  onClose,
}: {
  mode: 'upload' | 'replace';
  subjectType: SubjectType;
  subjectId: string;
  subjectName: string;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const mutation = useEnrollPhoto(subjectType, subjectId);

  return (
    <Modal
      title={mode === 'replace' ? 'Replace the photo' : 'Upload a photo'}
      onClose={onClose}
      dismissible={!mutation.isPending}
    >
      {mutation.data ? (
        <div className="biometric-enrollment-section__dialog">
          <EnrollmentOutcome enrollment={mutation.data} replacing={mode === 'replace'} />
          <div className="biometric-enrollment-section__dialog-actions">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="biometric-enrollment-section__dialog"
          onSubmit={(event) => {
            event.preventDefault();
            if (file) {
              mutation.mutate(file);
            }
          }}
        >
          {mode === 'replace' ? (
            <p className="biometric-enrollment-section__dialog-text">
              To delete this photo, provide its replacement first. Check-in needs a photo to confirm
              it&rsquo;s {subjectName}, so the current one is only removed once the new one is in
              place.
            </p>
          ) : (
            <p className="biometric-enrollment-section__dialog-text">
              A clear, front-facing photo of {subjectName}&rsquo;s face, on its own, in good light.
            </p>
          )}
          <ImageDropzone
            id={`${subjectType}-photo`}
            label={mode === 'replace' ? 'Replacement photo' : 'Photo'}
            value={file}
            onChange={(next) => {
              setFile(next);
              mutation.reset();
            }}
            accept={ENROLLMENT_CONTENT_TYPES}
            maxBytes={ENROLLMENT_MAX_BYTES}
            error={mutation.error?.message}
            busy={mutation.isPending}
            busyLabel="Uploading and checking the face..."
          />
          <div className="biometric-enrollment-section__dialog-actions">
            <Button type="button" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!file || mutation.isPending}>
              {mutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

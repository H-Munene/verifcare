import { Alert02Icon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link } from 'react-router-dom';
import type { BiometricEnrollment } from '../api/biometricEnrollments';
import './EnrollmentOutcome.css';

// What happened to a just-uploaded photo, shared by every place a photo is uploaded. A flagged
// photo isn't an error - the upload worked and the face looked like someone already enrolled, so
// it waits for a supervisor - but it needs saying plainly, because the photo isn't in use yet.
export function EnrollmentOutcome({
  enrollment,
  replacing = false,
}: {
  enrollment: BiometricEnrollment;
  /** True when there was already a photo, which stays in use while a flagged one waits. */
  replacing?: boolean;
}) {
  if (enrollment.status === 'flagged') {
    return (
      <div className="enrollment-outcome enrollment-outcome--flagged" role="status">
        <HugeiconsIcon icon={Alert02Icon} size={18} strokeWidth={1.8} aria-hidden />
        <div>
          <div className="enrollment-outcome__title">Sent for review</div>
          <p className="enrollment-outcome__text">
            This face looks like an already-enrolled {enrollment.matchedSubjectType} (
            {enrollment.matchedSimilarity?.toFixed(1)}% similar), so a supervisor needs to approve
            it on the <Link to="/reviews">Reviews</Link> page before check-in can use it.
            {replacing ? ' The current photo stays in use until then.' : ''}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="enrollment-outcome enrollment-outcome--active" role="status">
      <HugeiconsIcon icon={CheckmarkCircle02Icon} size={18} strokeWidth={1.8} aria-hidden />
      <div>
        <div className="enrollment-outcome__title">
          {replacing ? 'Photo replaced' : 'Photo saved'}
        </div>
        <p className="enrollment-outcome__text">
          Check-in will match against this photo from now on.
          {enrollment.qualityScore !== null
            ? ` Quality score ${enrollment.qualityScore.toFixed(1)} out of 100.`
            : ''}
        </p>
      </div>
    </div>
  );
}

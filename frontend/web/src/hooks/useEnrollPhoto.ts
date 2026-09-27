import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ENROLLMENT_CONTENT_TYPES,
  uploadFileToPresignedUrl,
  type EnrollmentContentType,
  type SubjectType,
} from '../api/biometricEnrollments';
import { useApi } from '../api/useApi';

// The one way this app enrolls a check-in photo (2026-09-27): ask for a presigned upload URL, PUT
// the bytes straight to S3, then confirm, which is where the server checks the face and flags a
// likely duplicate for review. Shared by the two registration wizards and the Enrollment tab so
// they can't drift apart.
//
// Always imageOrder 1: the POC keeps one photo per person (user decision, 2026-09-27), and the
// server retires every earlier active photo when a new one is activated.
export function useEnrollPhoto(subjectType: SubjectType, subjectId: string | null) {
  const { biometricEnrollments } = useApi();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (file: File) => {
      if (!subjectId) {
        throw new Error('Save the details first, then add the photo.');
      }
      if (!ENROLLMENT_CONTENT_TYPES.includes(file.type as EnrollmentContentType)) {
        throw new Error('Only JPG or PNG images are accepted.');
      }
      const presigned = await biometricEnrollments.createUploadUrl({
        subjectType,
        subjectId,
        imageOrder: 1,
        contentType: file.type as EnrollmentContentType,
      });
      await uploadFileToPresignedUrl(presigned.uploadUrl, file);
      return biometricEnrollments.confirmEnrollment({
        subjectType,
        subjectId,
        s3Key: presigned.s3Key,
        imageOrder: 1,
      });
    },
    onSuccess: () => {
      // The prefix covers the person's record too (e.g. ['dependant', id]), whose check-in photo
      // status the new photo may have changed, as well as every photo list for them.
      void queryClient.invalidateQueries({ queryKey: [subjectType, subjectId] });
      void queryClient.invalidateQueries({ queryKey: ['flagged-enrollments'] });
    },
  });
}

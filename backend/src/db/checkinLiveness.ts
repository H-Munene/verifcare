// Single-photo identity check for a check-in step (caregiver or dependant), HEZ-34.
//
// Revised 2026-09-19, same session as the original build: this was originally a multi-frame
// challenge-response liveness check (a randomized prompt, DetectFaces across a captured frame
// burst, pose/eye movement evaluated against the specific issued challenge). The user explicitly
// decided to drop real liveness/anti-spoofing detection in favor of a single photo, for caregiver
// mobile app build simplicity - a deliberate, informed security tradeoff (a printed or displayed
// photo of the caregiver can no longer be distinguished from the caregiver actually being present,
// since a single still image can't demonstrate movement over time), not an oversight or a
// misunderstanding of what was being removed. See routes/checkin.ts's header comment and
// docs/architecture.md's "Key design decisions" for the full record of that decision.
//
// What remains here is much smaller: confirm the uploaded photo shows exactly one face, the same
// zero-tolerance rule db/biometricStorage.ts's assessFaceQuality already applies to enrollment
// images (a photo that can't be trusted to be "one face" can't be trusted for CompareFaces either).
// No quality scoring is needed - there is only ever one photo per attempt now, not several to pick
// the best of.

import { DetectFacesCommand, type RekognitionClient } from '@aws-sdk/client-rekognition';

export type PhotoCheckResult =
  { ok: true } | { ok: false; reason: 'no_face_detected' | 'multiple_faces_detected' };

export interface CheckinPhotoValidator {
  validatePhoto: (params: { bucketName: string; s3Key: string }) => Promise<PhotoCheckResult>;
}

export function createCheckinPhotoValidator(params: {
  rekognitionClient: RekognitionClient;
}): CheckinPhotoValidator {
  const { rekognitionClient } = params;

  return {
    validatePhoto: async ({ bucketName, s3Key }): Promise<PhotoCheckResult> => {
      const response = await rekognitionClient.send(
        new DetectFacesCommand({
          Image: { S3Object: { Bucket: bucketName, Name: s3Key } },
        }),
      );
      const faces = response.FaceDetails ?? [];
      if (faces.length === 0) {
        return { ok: false, reason: 'no_face_detected' };
      }
      if (faces.length > 1) {
        return { ok: false, reason: 'multiple_faces_detected' };
      }
      return { ok: true };
    },
  };
}

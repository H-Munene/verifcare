// Biometric enrollment image storage and quality assessment (HEZ-31): a presigned-upload wrapper
// around S3, and a Rekognition DetectFaces-based quality_score computation, behind one fakeable
// interface - same createXxx(params): XxxInterface shape as auth/cognitoAdmin.ts, so
// routes/biometricEnrollments.integration.test.ts can inject a fake instead of hitting real AWS.
//
// quality_score design (confirmed with the user as a certified-AWS-architect recommendation,
// grounded in AWS's own docs, not guessed - see docs/project-state.md's HEZ-31 entry for the full
// reasoning and citations):
// - Computed synchronously, here, at confirm time (POST /biometric-enrollments) via a single
//   Rekognition DetectFaces call against the already-uploaded S3 object (Image.S3Object - no
//   download needed). DetectFaces is fast and stateless; an async S3-event/queue pipeline would
//   add real operational surface for no benefit at this call volume.
// - Rejected outright (no score, no row written) if DetectFaces finds zero or more than one face -
//   an image like that can never be used by CompareFaces (HEZ-36) anyway, so scoring it would only
//   let a corrupt "best active image" ever be selected.
// - Otherwise: quality_score = min(Quality.Brightness, Quality.Sharpness) (both already 0-100 on
//   Rekognition's own scale - the weaker dimension is used, not an invented weighted average,
//   since a sharp-but-dark or bright-but-blurry photo is still a poor reference image either way),
//   halved as a soft penalty (not a second rejection - this project has no "recapture" flow, and a
//   supervisor/family member may only get one attempt in the field) when the face falls outside
//   AWS's documented recommendations for facial comparison input images: eyes closed, occluded, or
//   pose outside the recommended range. Pitch's up/down sign convention is not stated in AWS's own
//   API reference (checked directly - Pose.Pitch's docs give only a [-180, 180] range, no polarity),
//   so a symmetric |pitch| > 45 bound is used deliberately instead of guessing which sign means
//   "down" and risking the asymmetric 30/45 rule applying backwards; yaw uses the documented
//   |yaw| > 45 bound directly, which has no such ambiguity.

import {
  DetectFacesCommand,
  type FaceDetail,
  type RekognitionClient,
} from '@aws-sdk/client-rekognition';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v7 as uuidv7 } from 'uuid';

const UPLOAD_URL_EXPIRY_SECONDS = 300;
// Long enough to cover a supervisor viewing a caregiver/dependant detail page (the frontend
// requests a fresh batch of these on every page load, not once and cached), short enough to still
// be a genuinely time-limited link rather than a de facto permanent public URL.
const VIEW_URL_EXPIRY_SECONDS = 900;
const POSE_YAW_MAX_DEGREES = 45;
const POSE_PITCH_MAX_DEGREES = 45;
const SOFT_PENALTY_FACTOR = 0.5;

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export interface CreateUploadUrlParams {
  subjectType: 'caregiver' | 'dependant';
  subjectId: string;
  imageOrder: number;
  contentType: string;
}

export interface CreatedUploadUrl {
  uploadUrl: string;
  s3Key: string;
  expiresAt: Date;
}

export type FaceQualityResult =
  | { ok: true; qualityScore: number }
  | { ok: false; reason: 'no_face_detected' | 'multiple_faces_detected' };

export interface BiometricStorage {
  createUploadUrl: (params: CreateUploadUrlParams) => Promise<CreatedUploadUrl>;
  createViewUrl: (s3Key: string) => Promise<string>;
  objectExists: (s3Key: string) => Promise<boolean>;
  assessFaceQuality: (s3Key: string) => Promise<FaceQualityResult>;
}

// The s3Key prefix every upload/confirm pair must agree on - exported so the router can verify a
// submitted s3Key actually belongs to the subject/imageOrder it claims, before trusting it enough
// to call Rekognition or write a row.
export function biometricKeyPrefix(
  subjectType: string,
  subjectId: string,
  imageOrder: number,
): string {
  return `${subjectType}/${subjectId}/${imageOrder}/`;
}

function scoreFace(face: FaceDetail): number {
  const brightness = face.Quality?.Brightness ?? 0;
  const sharpness = face.Quality?.Sharpness ?? 0;
  const raw = Math.min(brightness, sharpness);

  const eyesClosed = face.EyesOpen?.Value === false;
  const occluded = face.FaceOccluded?.Value === true;
  const pitch = face.Pose?.Pitch;
  const yaw = face.Pose?.Yaw;
  const poseOutOfRange =
    (pitch !== undefined && Math.abs(pitch) > POSE_PITCH_MAX_DEGREES) ||
    (yaw !== undefined && Math.abs(yaw) > POSE_YAW_MAX_DEGREES);

  return eyesClosed || occluded || poseOutOfRange ? raw * SOFT_PENALTY_FACTOR : raw;
}

export function createBiometricStorage(params: {
  s3Client: S3Client;
  rekognitionClient: RekognitionClient;
  bucketName: string;
}): BiometricStorage {
  const { s3Client, rekognitionClient, bucketName } = params;

  return {
    createUploadUrl: async ({
      subjectType,
      subjectId,
      imageOrder,
      contentType,
    }): Promise<CreatedUploadUrl> => {
      const extension = CONTENT_TYPE_EXTENSIONS[contentType];
      if (!extension) {
        throw new Error(`Unsupported contentType: ${contentType}.`);
      }
      const s3Key = `${biometricKeyPrefix(subjectType, subjectId, imageOrder)}${uuidv7()}.${extension}`;
      const uploadUrl = await getSignedUrl(
        s3Client,
        new PutObjectCommand({ Bucket: bucketName, Key: s3Key, ContentType: contentType }),
        { expiresIn: UPLOAD_URL_EXPIRY_SECONDS },
      );
      return {
        uploadUrl,
        s3Key,
        expiresAt: new Date(Date.now() + UPLOAD_URL_EXPIRY_SECONDS * 1000),
      };
    },

    // A GET presigned URL for the admin web app to actually render a subject's enrolled photos -
    // the row itself never exposes its raw s3Key (routes/biometricEnrollments.ts's toResponse), so
    // this is the only way a client ever gets something an <img> tag can load.
    createViewUrl: (s3Key: string): Promise<string> =>
      getSignedUrl(s3Client, new GetObjectCommand({ Bucket: bucketName, Key: s3Key }), {
        expiresIn: VIEW_URL_EXPIRY_SECONDS,
      }),

    objectExists: async (s3Key: string): Promise<boolean> => {
      try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: s3Key }));
        return true;
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { name?: unknown }).name === 'NotFound'
        ) {
          return false;
        }
        throw err;
      }
    },

    assessFaceQuality: async (s3Key: string): Promise<FaceQualityResult> => {
      const response = await rekognitionClient.send(
        new DetectFacesCommand({
          Image: { S3Object: { Bucket: bucketName, Name: s3Key } },
          // DEFAULT already includes Quality/Pose - EYES_OPEN and FACE_OCCLUDED are the only
          // attributes this scoring rule needs beyond that.
          Attributes: ['DEFAULT', 'EYES_OPEN', 'FACE_OCCLUDED'],
        }),
      );
      const faces = response.FaceDetails ?? [];
      if (faces.length === 0) {
        return { ok: false, reason: 'no_face_detected' };
      }
      if (faces.length > 1) {
        return { ok: false, reason: 'multiple_faces_detected' };
      }
      const [face] = faces;
      if (!face) {
        throw new Error('faces.length === 1 but faces[0] is undefined.');
      }
      return { ok: true, qualityScore: scoreFace(face) };
    },
  };
}

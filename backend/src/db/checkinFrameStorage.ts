// Check-in liveness capture frame storage (HEZ-34) - the same createUploadUrl/objectExists shape
// db/biometricStorage.ts already established, plus deleteObjects (a grant
// biometricEnrollmentsBucket deliberately does not have - see infra/lib/api.ts's comment on why
// this bucket does). Kept as its own small module rather than generalizing biometricStorage.ts
// itself: that module's assessFaceQuality is bound to one specific quality-scoring policy for
// enrollment images, which doesn't apply here, and this module has no quality-assessment
// responsibility at all (db/checkinLiveness.ts owns that, over multiple frames at once).

import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v7 as uuidv7 } from 'uuid';

const UPLOAD_URL_EXPIRY_SECONDS = 300;

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export interface CreateFrameUploadUrlParams {
  visitScheduleId: string;
  subject: 'caregiver' | 'dependant';
  contentType: string;
}

export interface CreatedFrameUploadUrl {
  uploadUrl: string;
  s3Key: string;
  expiresAt: Date;
}

export interface CheckinFrameStorage {
  createUploadUrl: (params: CreateFrameUploadUrlParams) => Promise<CreatedFrameUploadUrl>;
  objectExists: (s3Key: string) => Promise<boolean>;
  // Best-effort cleanup is the caller's responsibility (log-and-continue, not fatal to the
  // request) - matches db/biometricOffboarding.ts's established reasoning for the same kind of
  // best-effort AWS cleanup call.
  deleteObjects: (s3Keys: string[]) => Promise<void>;
}

// Exported so the router can verify a submitted frame's s3Key actually belongs to this visit and
// subject before trusting it enough to call Rekognition - same reasoning as
// db/biometricStorage.ts's biometricKeyPrefix().
export function frameKeyPrefix(
  visitScheduleId: string,
  subject: 'caregiver' | 'dependant',
): string {
  return `${visitScheduleId}/${subject}/`;
}

export function createCheckinFrameStorage(params: {
  s3Client: S3Client;
  bucketName: string;
}): CheckinFrameStorage {
  const { s3Client, bucketName } = params;

  return {
    createUploadUrl: async ({
      visitScheduleId,
      subject,
      contentType,
    }): Promise<CreatedFrameUploadUrl> => {
      const extension = CONTENT_TYPE_EXTENSIONS[contentType];
      if (!extension) {
        throw new Error(`Unsupported contentType: ${contentType}.`);
      }
      const s3Key = `${frameKeyPrefix(visitScheduleId, subject)}${uuidv7()}.${extension}`;
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

    deleteObjects: async (s3Keys: string[]): Promise<void> => {
      if (s3Keys.length === 0) {
        return;
      }
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: { Objects: s3Keys.map((Key) => ({ Key })) },
        }),
      );
    },
  };
}

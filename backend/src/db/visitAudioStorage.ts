// S3 access for the visit's 30-second recording (2026-11-09). The phone uploads straight to S3
// through a presigned URL, and family members play it back through another, so audio never passes
// through the Lambda and access is decided per request by the API.

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v7 as uuidv7 } from 'uuid';

const UPLOAD_URL_EXPIRY_SECONDS = 300;
const PLAYBACK_URL_EXPIRY_SECONDS = 300;

export const VISIT_AUDIO_CONTENT_TYPE = 'audio/mp4';

export interface VisitAudioStorage {
  createUploadUrl: (
    visitScheduleId: string,
  ) => Promise<{ uploadUrl: string; s3Key: string; expiresAt: Date }>;
  /** The object's size in bytes, or null when no such object exists. */
  objectSize: (s3Key: string) => Promise<number | null>;
  createPlaybackUrl: (s3Key: string) => Promise<{ url: string; expiresAt: Date }>;
}

// Exported so the router can check that a submitted key belongs to the visit it's submitted for.
export function visitAudioKeyPrefix(visitScheduleId: string): string {
  return `${visitScheduleId}/`;
}

export function createVisitAudioStorage(params: {
  s3Client: S3Client;
  bucketName: string;
}): VisitAudioStorage {
  const { s3Client, bucketName } = params;

  return {
    createUploadUrl: async (visitScheduleId) => {
      const s3Key = `${visitAudioKeyPrefix(visitScheduleId)}${uuidv7()}.m4a`;
      const uploadUrl = await getSignedUrl(
        s3Client,
        new PutObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
          ContentType: VISIT_AUDIO_CONTENT_TYPE,
        }),
        { expiresIn: UPLOAD_URL_EXPIRY_SECONDS },
      );
      return {
        uploadUrl,
        s3Key,
        expiresAt: new Date(Date.now() + UPLOAD_URL_EXPIRY_SECONDS * 1000),
      };
    },

    objectSize: async (s3Key) => {
      try {
        const head = await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: s3Key }));
        return head.ContentLength ?? 0;
      } catch (err) {
        if ((err as { name?: unknown }).name === 'NotFound') {
          return null;
        }
        throw err;
      }
    },

    createPlaybackUrl: async (s3Key) => {
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: bucketName, Key: s3Key }),
        { expiresIn: PLAYBACK_URL_EXPIRY_SECONDS },
      );
      return { url, expiresAt: new Date(Date.now() + PLAYBACK_URL_EXPIRY_SECONDS * 1000) };
    },
  };
}

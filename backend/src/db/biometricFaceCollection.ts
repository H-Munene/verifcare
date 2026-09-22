// Rekognition Collection wrapper for HEZ-85's enrollment-uniqueness check: is this face already
// enrolled under a *different* subject? A materially different mechanism from db/biometricStorage.ts's
// DetectFaces-based quality scoring - that's a 1:1, no-state check; this is a 1:N search against every
// previously enrolled face, which is exactly what Rekognition Collections (IndexFaces/
// SearchFacesByImage) are for. See docs/architecture.md's "Biometric enrollment uniqueness" section
// for the full reasoning on why this is a deliberate, narrow exception to this project's otherwise
// Collections-free design.
//
// ExternalImageId shape: `${subjectType}:${subjectId}` (e.g. "dependant:0198e4b2-..."), matching
// IndexFaces' allowed pattern ([a-zA-Z0-9_.\-:]+) - the one identifier this module needs to tell
// "is this match the same subject being enrolled, or someone else" apart.
//
// FaceMatchThreshold is deliberately higher than CompareFaces' verification threshold (confirmed
// with the user as a real, considered choice, not an invented default): related people (siblings,
// parent/child) can score well above a verification-tuned 80% on face-similarity models, so a
// fraud/uniqueness check needs enough headroom that a genuinely different, related person doesn't
// get flagged as a duplicate.

import {
  DeleteFacesCommand,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  type RekognitionClient,
} from '@aws-sdk/client-rekognition';

const DUPLICATE_FACE_MATCH_THRESHOLD = 95;
// Search a handful of candidates, not just the top 1: the top-ranked match can legitimately be the
// enrolling subject's own prior image (a different imageOrder of theirs), which isn't a duplicate -
// the real duplicate, if any, could be ranked just below it.
const DUPLICATE_SEARCH_MAX_FACES = 10;

export function externalImageId(subjectType: 'caregiver' | 'dependant', subjectId: string): string {
  return `${subjectType}:${subjectId}`;
}

export function parseExternalImageId(
  value: string,
): { subjectType: 'caregiver' | 'dependant'; subjectId: string } | undefined {
  const [subjectType, subjectId] = value.split(':');
  if ((subjectType !== 'caregiver' && subjectType !== 'dependant') || !subjectId) {
    return undefined;
  }
  return { subjectType, subjectId };
}

export type DuplicateCheckResult =
  | { duplicate: false }
  | {
      duplicate: true;
      matchedSubjectType: 'caregiver' | 'dependant';
      matchedSubjectId: string;
      similarity: number;
    };

export interface BiometricFaceCollection {
  // Searches the collection for this face, excluding matches that belong to `self` (the subject
  // currently being enrolled - their own prior images shouldn't ever count as a "duplicate" of
  // themselves). Returns the first (highest-similarity) match belonging to someone else, if any.
  checkDuplicate: (params: {
    s3Key: string;
    self: { subjectType: 'caregiver' | 'dependant'; subjectId: string };
  }) => Promise<DuplicateCheckResult>;
  // Adds this face to the collection under the given subject's ExternalImageId, returning the
  // Rekognition-assigned FaceId (stored on the biometric_enrollments row for later DeleteFaces).
  indexFace: (params: {
    s3Key: string;
    subjectType: 'caregiver' | 'dependant';
    subjectId: string;
  }) => Promise<string>;
  // Removes previously-indexed faces from the collection (offboarding cleanup) - a no-op-safe call
  // with an empty array, since a subject may have zero indexed faces (e.g. only ever flagged, never
  // approved).
  deleteFaces: (faceIds: string[]) => Promise<void>;
}

export function createBiometricFaceCollection(params: {
  rekognitionClient: RekognitionClient;
  collectionId: string;
  bucketName: string;
}): BiometricFaceCollection {
  const { rekognitionClient, collectionId, bucketName } = params;

  return {
    checkDuplicate: async ({ s3Key, self }): Promise<DuplicateCheckResult> => {
      const response = await rekognitionClient.send(
        new SearchFacesByImageCommand({
          CollectionId: collectionId,
          Image: { S3Object: { Bucket: bucketName, Name: s3Key } },
          FaceMatchThreshold: DUPLICATE_FACE_MATCH_THRESHOLD,
          MaxFaces: DUPLICATE_SEARCH_MAX_FACES,
        }),
      );
      const selfExternalId = externalImageId(self.subjectType, self.subjectId);
      for (const match of response.FaceMatches ?? []) {
        const matchedExternalId = match.Face?.ExternalImageId;
        const similarity = match.Similarity;
        if (
          !matchedExternalId ||
          matchedExternalId === selfExternalId ||
          similarity === undefined
        ) {
          continue;
        }
        const parsed = parseExternalImageId(matchedExternalId);
        if (!parsed) {
          continue;
        }
        return {
          duplicate: true,
          matchedSubjectType: parsed.subjectType,
          matchedSubjectId: parsed.subjectId,
          similarity,
        };
      }
      return { duplicate: false };
    },

    indexFace: async ({ s3Key, subjectType, subjectId }): Promise<string> => {
      const response = await rekognitionClient.send(
        new IndexFacesCommand({
          CollectionId: collectionId,
          Image: { S3Object: { Bucket: bucketName, Name: s3Key } },
          ExternalImageId: externalImageId(subjectType, subjectId),
          // Exactly one face is already guaranteed by db/biometricStorage.ts's assessFaceQuality
          // rejecting anything else before this is ever called.
          MaxFaces: 1,
          DetectionAttributes: [],
        }),
      );
      const faceId = response.FaceRecords?.[0]?.Face?.FaceId;
      if (!faceId) {
        throw new Error(
          'IndexFaces did not return a FaceId for an image that already passed DetectFaces.',
        );
      }
      return faceId;
    },

    deleteFaces: async (faceIds: string[]): Promise<void> => {
      if (faceIds.length === 0) {
        return;
      }
      await rekognitionClient.send(
        new DeleteFacesCommand({ CollectionId: collectionId, FaceIds: faceIds }),
      );
    },
  };
}

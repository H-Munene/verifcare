// CompareFaces integration (Linear HEZ-36 - "Compare the best-quality captured frame against each
// enrolled reference image in S3, for both caregiver and dependant"). Built as part of HEZ-34
// since openapi.yaml's own POST /checkin/caregiver-liveness contract requires it directly
// ("DetectFaces runs..., then CompareFaces against the caregiver's enrolled reference images"), as
// a standalone, subject-agnostic module from the start so HEZ-35's dependant-liveness step reuses
// it unchanged rather than duplicating this logic - candidates are passed in by the caller (a
// plain S3 bucket+key list), so this module never queries the database itself, the same
// AWS-client-only separation db/biometricStorage.ts and db/biometricFaceCollection.ts already use.
//
// Candidates are tried best-quality first, per architecture.md's own stated rule ("CompareFaces
// runs against the highest-quality active image, with the others as fallback") - the caller is
// responsible for that ordering (a query against biometric_enrollments sorted by quality_score
// DESC), not this module.
//
// Match threshold: 80% (architecture.md's explicit, settled "verification's 80%" figure -
// deliberately looser than enrollment-uniqueness's 95% stricter fraud-detection threshold, since
// this is a 1:1 identity check against a person's own enrollment, not a search across everyone
// else in the system - see architecture.md's "Biometric enrollment uniqueness" section for why
// those two thresholds are deliberately different numbers, not the same one reused).

import { CompareFacesCommand, type RekognitionClient } from '@aws-sdk/client-rekognition';

export interface FaceMatchCandidate {
  bucket: string;
  s3Key: string;
}

export type CompareFacesResult =
  | { matched: true; similarity: number; matchedS3Key: string }
  | { matched: false; bestSimilarity: number | null };

export interface FaceMatcher {
  compareAgainstCandidates: (params: {
    sourceBucket: string;
    sourceS3Key: string;
    candidates: FaceMatchCandidate[];
    matchThresholdPercent: number;
  }) => Promise<CompareFacesResult>;
}

export function createFaceMatcher(params: { rekognitionClient: RekognitionClient }): FaceMatcher {
  const { rekognitionClient } = params;

  return {
    compareAgainstCandidates: async ({
      sourceBucket,
      sourceS3Key,
      candidates,
      matchThresholdPercent,
    }): Promise<CompareFacesResult> => {
      let bestSimilarity: number | null = null;

      for (const candidate of candidates) {
        const response = await rekognitionClient.send(
          new CompareFacesCommand({
            SourceImage: { S3Object: { Bucket: sourceBucket, Name: sourceS3Key } },
            TargetImage: { S3Object: { Bucket: candidate.bucket, Name: candidate.s3Key } },
            // 0, not matchThresholdPercent: filtering server-side would mean a below-threshold
            // candidate returns no similarity figure at all (CompareFaces' UnmatchedFaces entries
            // carry no Similarity field), losing real audit signal on *how close* a failed match
            // was. The threshold is applied here in code instead, against the raw similarity every
            // comparison returns.
            SimilarityThreshold: 0,
          }),
        );
        const [bestMatch] = response.FaceMatches ?? [];
        const similarity = bestMatch?.Similarity;
        if (similarity === undefined) {
          continue;
        }
        if (bestSimilarity === null || similarity > bestSimilarity) {
          bestSimilarity = similarity;
        }
        if (similarity >= matchThresholdPercent) {
          return { matched: true, similarity, matchedS3Key: candidate.s3Key };
        }
      }

      return { matched: false, bestSimilarity };
    },
  };
}

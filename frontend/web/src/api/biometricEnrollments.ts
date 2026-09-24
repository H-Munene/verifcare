// Typed request/response shapes and calls for /biometric-enrollments, matching
// backend/src/routes/biometricEnrollments.ts's response shapes and backend/openapi.yaml exactly.

import type { ApiClient } from './client';

export type SubjectType = 'caregiver' | 'dependant';
export type BiometricEnrollmentStatus = 'active' | 'superseded' | 'deleted' | 'flagged';

export interface BiometricEnrollment {
  id: string;
  subjectType: SubjectType;
  caregiverId: string | null;
  dependantId: string | null;
  imageOrder: number;
  imageUrl: string;
  qualityScore: number | null;
  status: BiometricEnrollmentStatus;
  matchedSubjectType: SubjectType | null;
  matchedSubjectId: string | null;
  matchedSimilarity: number | null;
  enrolledBy: string;
  enrolledAt: string;
  updatedAt: string;
}

export interface BiometricEnrollmentPage {
  items: BiometricEnrollment[];
  nextCursor: string | null;
}

export interface PresignedUpload {
  uploadUrl: string;
  s3Key: string;
  expiresAt: string;
}

export interface CreateUploadUrlRequest {
  subjectType: SubjectType;
  subjectId: string;
  imageOrder: number;
  contentType: 'image/jpeg' | 'image/png';
}

export interface CreateBiometricEnrollmentRequest {
  subjectType: SubjectType;
  subjectId: string;
  s3Key: string;
  imageOrder: number;
}

export interface ListFlaggedParams {
  cursor?: string;
  limit?: number;
}

function toQueryString<T extends object>(params: T): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value as string | number));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function createBiometricEnrollmentsApi(client: ApiClient) {
  return {
    createUploadUrl: (body: CreateUploadUrlRequest) =>
      client.post<PresignedUpload>('/biometric-enrollments/upload-url', body),
    confirmEnrollment: (body: CreateBiometricEnrollmentRequest) =>
      client.post<BiometricEnrollment>('/biometric-enrollments', body),
    listEnrollments: (subjectType: SubjectType, subjectId: string) =>
      client.get<BiometricEnrollment[]>(
        `/biometric-enrollments${toQueryString({ subjectType, subjectId })}`,
      ),
    listFlagged: (params: ListFlaggedParams = {}) =>
      client.get<BiometricEnrollmentPage>(`/biometric-enrollments/flagged${toQueryString(params)}`),
    approveEnrollment: (id: string) =>
      client.post<BiometricEnrollment>(`/biometric-enrollments/${id}/approve`),
    rejectEnrollment: (id: string) =>
      client.post<BiometricEnrollment>(`/biometric-enrollments/${id}/reject`),
  };
}

export type BiometricEnrollmentsApi = ReturnType<typeof createBiometricEnrollmentsApi>;

// Uploads the raw file bytes directly to S3 via the presigned URL - deliberately NOT routed
// through ApiClient: S3 rejects a request carrying our own bearer token/JSON headers, since the
// presigned URL's own signature is the only auth it expects.
export async function uploadFileToPresignedUrl(uploadUrl: string, file: File): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!response.ok) {
    throw new Error(`Upload to S3 failed: ${response.status} ${response.statusText}`);
  }
}

// Typed request/response shapes and calls for /visit-schedules, matching
// backend/src/routes/visitSchedules.ts's actual VisitScheduleResponse interface and
// backend/openapi.yaml exactly - not re-derived from scratch. Mirrors api/caregivers.ts's exact
// module shape.

import type { ApiClient } from './client';

export type VisitStatus =
  'scheduled' | 'in_progress' | 'completed' | 'missed' | 'cancelled' | 'investigated';

export interface VisitSchedule {
  id: string;
  caregiverId: string;
  dependantId: string;
  caregiverDisplayName: string;
  dependantDisplayName: string;
  scheduledStart: string;
  scheduledEnd: string;
  status: VisitStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type VerificationAttemptType = 'geofence' | 'caregiver_liveness' | 'dependant_liveness';

export interface VerificationEvent {
  visitScheduleId: string;
  checkinAt: string | null;
  checkoutAt: string | null;
  checkinGpsLat: number | null;
  checkinGpsLng: number | null;
  distanceFromGeofenceMeters: number | null;
  caregiverMatchConfidence: number | null;
  dependantMatchConfidence: number | null;
  caregiverLivenessPassed: boolean | null;
  dependantLivenessPassed: boolean | null;
}

export interface VerificationAttempt {
  id: string;
  visitScheduleId: string;
  attemptType: VerificationAttemptType;
  passed: boolean;
  failureReason: string | null;
  attemptedAt: string;
}

export interface VerificationAudit {
  event: VerificationEvent | null;
  attempts: VerificationAttempt[];
}

export interface VisitSchedulePage {
  items: VisitSchedule[];
  nextCursor: string | null;
}

export interface CreateVisitScheduleRequest {
  caregiverId: string;
  dependantId: string;
  scheduledStart: string;
  scheduledEnd: string;
}

export interface UpdateVisitScheduleRequest {
  scheduledStart?: string;
  scheduledEnd?: string;
  status?: VisitStatus;
}

export interface ListVisitSchedulesParams {
  status?: VisitStatus;
  caregiverId?: string;
  dependantId?: string;
  scheduledStartFrom?: string;
  scheduledStartTo?: string;
  cursor?: string;
  limit?: number;
}

function toQueryString(params: ListVisitSchedulesParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function createVisitSchedulesApi(client: ApiClient) {
  return {
    listVisitSchedules: (params: ListVisitSchedulesParams = {}) =>
      client.get<VisitSchedulePage>(`/visit-schedules${toQueryString(params)}`),
    getVisitSchedule: (visitScheduleId: string) =>
      client.get<VisitSchedule>(`/visit-schedules/${visitScheduleId}`),
    getVisitVerification: (visitScheduleId: string) =>
      client.get<VerificationAudit>(`/visit-schedules/${visitScheduleId}/verification`),
    createVisitSchedule: (body: CreateVisitScheduleRequest) =>
      client.post<VisitSchedule>('/visit-schedules', body),
    updateVisitSchedule: (visitScheduleId: string, body: UpdateVisitScheduleRequest) =>
      client.patch<VisitSchedule>(`/visit-schedules/${visitScheduleId}`, body),
  };
}

export type VisitSchedulesApi = ReturnType<typeof createVisitSchedulesApi>;

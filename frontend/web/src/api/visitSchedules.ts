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
  scheduledStart: string;
  scheduledEnd: string;
  status: VisitStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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
    createVisitSchedule: (body: CreateVisitScheduleRequest) =>
      client.post<VisitSchedule>('/visit-schedules', body),
    updateVisitSchedule: (visitScheduleId: string, body: UpdateVisitScheduleRequest) =>
      client.patch<VisitSchedule>(`/visit-schedules/${visitScheduleId}`, body),
  };
}

export type VisitSchedulesApi = ReturnType<typeof createVisitSchedulesApi>;

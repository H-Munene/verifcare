// Typed calls for /visit-plans, matching backend/src/routes/visitPlans.ts and backend/openapi.yaml.

import type { ApiClient } from './client';

export interface PlanStop {
  dependantId: string;
  dependantName: string;
  lat: number | null;
  lng: number | null;
  ward: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  travelMinutes: number;
  distanceMeters: number;
}

export interface PlanCluster {
  id: string;
  caregiverId: string;
  caregiverName: string;
  base: { lat: number | null; lng: number | null };
  totalDistanceMeters: number;
  totalTravelMinutes: number;
  stops: PlanStop[];
}

export type UnplacedReason = 'already_scheduled' | 'no_consent' | 'shift_full';
export type ExcludedReason = 'already_scheduled' | 'no_consent' | 'no_home_base';

export interface VisitPlan {
  id: string;
  date: string;
  shiftStart: string;
  shiftEnd: string;
  visitMinutes: number;
  status: 'draft' | 'published';
  publishedAt: string | null;
  clusters: PlanCluster[];
  unplaced: { dependantId: string; dependantName: string; reason: UnplacedReason }[];
  excludedCaregivers: { caregiverId: string; caregiverName: string; reason: ExcludedReason }[];
}

export interface CreatePlanRequest {
  date: string;
  shiftStart: string;
  shiftEnd: string;
  visitMinutes: number;
}

export type PlanArrangement = { caregiverId: string; dependantIds: string[] }[];

export function createVisitPlansApi(client: ApiClient) {
  return {
    listPlans: (date: string) =>
      client.get<{ items: VisitPlan[] }>(`/visit-plans?date=${encodeURIComponent(date)}`),
    createPlan: (body: CreatePlanRequest) => client.post<VisitPlan>('/visit-plans', body),
    rearrange: (planId: string, clusters: PlanArrangement) =>
      client.patch<VisitPlan>(`/visit-plans/${planId}`, { clusters }),
    publish: (planId: string) => client.post<VisitPlan>(`/visit-plans/${planId}/publish`),
  };
}

export type VisitPlansApi = ReturnType<typeof createVisitPlansApi>;

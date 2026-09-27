// Typed request/response shapes and calls for /dependants, matching
// backend/src/routes/dependants.ts's actual DependantResponse/DependantFamilyMemberResponse
// interfaces and backend/openapi.yaml exactly - not re-derived from scratch.

import type { ApiClient } from './client';
import type { VisitStats } from './visitStats';

export type DependantStatus = 'active' | 'deactivated';
export type DependantGender = 'male' | 'female';
export type FamilyMemberIdType = 'national_id' | 'passport';

export interface Dependant {
  id: string;
  fullName: string;
  dob: string;
  gender: DependantGender | null;
  homeAddressText: string | null;
  primaryConditionSummary: string | null;
  county: string | null;
  constituency: string | null;
  ward: string | null;
  geofenceLat: number;
  geofenceLng: number;
  geofenceRadiusMeters: number;
  cognitiveMonitoringEnabled: boolean;
  status: DependantStatus;
  // Where the check-in photo stands (backend db/checkinPhotos.ts): only 'ready' lets a visit be
  // scheduled.
  checkinPhotoStatus: CheckinPhotoStatus;
  registeredBy: string;
  createdAt: string;
  updatedAt: string;
}

export type CheckinPhotoStatus = 'ready' | 'awaiting_review' | 'missing';

export interface DependantPage {
  items: Dependant[];
  nextCursor: string | null;
}

export interface DependantFamilyMember {
  dependantId: string;
  familyMemberUserId: string;
  fullName: string;
  relationship: string | null;
  isPrimaryContact: boolean;
  addedBy: string;
  // When the link was made.
  createdAt: string;
  email: string | null;
  phoneNumber: string | null;
  addedByName: string | null;
  // Returned to supervisors only (see backend/openapi.yaml's DependantFamilyMember).
  idType?: 'national_id' | 'passport' | null;
  idNumber?: string | null;
}

// Exactly one of cognitoSub/email must be set - cognitoSub links an existing Cognito identity;
// email creates a brand-new one from scratch (2026-09-14, see backend/openapi.yaml's
// AddFamilyMemberRequest for the full contract). Built by components/FamilyMemberResolver.tsx,
// not typed directly by hand in any page. idType/idNumber are required together on the email path
// (enforced server-side) and ignored on the cognitoSub path.
export interface AddFamilyMemberRequest {
  cognitoSub?: string;
  email?: string;
  phoneNumber: string;
  fullName: string;
  idType?: FamilyMemberIdType;
  idNumber?: string;
  relationship?: string;
  isPrimaryContact?: boolean;
}

export interface CreateDependantRequest {
  fullName: string;
  dob: string;
  gender?: DependantGender;
  homeAddressText?: string;
  primaryConditionSummary?: string;
  // Required for every new registration (unlike homeAddressText's own optional treatment) -
  // resolved client-side via the geofence map's point-in-polygon lookup (HEZ-86).
  county: string;
  constituency: string;
  ward: string;
  geofenceLat: number;
  geofenceLng: number;
  geofenceRadiusMeters: number;
  cognitiveMonitoringEnabled?: boolean;
  primaryFamilyMember: AddFamilyMemberRequest;
}

export interface UpdateDependantRequest {
  fullName?: string;
  gender?: DependantGender;
  homeAddressText?: string;
  primaryConditionSummary?: string;
  county?: string;
  constituency?: string;
  ward?: string;
  geofenceLat?: number;
  geofenceLng?: number;
  geofenceRadiusMeters?: number;
  cognitiveMonitoringEnabled?: boolean;
  status?: DependantStatus;
}

export interface UpdateFamilyMemberRequest {
  relationship?: string;
  isPrimaryContact?: boolean;
}

// Visit task checklist (docs/visit-task-checklist-plan.md) - the care plan itself, authored on
// its own Care Plan screen (CarePlanPage.tsx), not part of dependant registration.
export interface CareTask {
  id: string;
  dependantId: string;
  title: string;
  description: string | null;
  category: string | null;
  required: boolean;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCareTaskRequest {
  title: string;
  description?: string;
  category?: string;
  required?: boolean;
}

export interface UpdateCareTaskRequest {
  title?: string;
  description?: string;
  category?: string;
  required?: boolean;
  active?: boolean;
}

export interface ListDependantsParams {
  status?: DependantStatus;
  photo?: CheckinPhotoStatus;
  sort?: 'name' | '-name' | 'dob' | '-dob';
  cursor?: string;
  limit?: number;
}

function toQueryString(params: ListDependantsParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function createDependantsApi(client: ApiClient) {
  return {
    listDependants: (params: ListDependantsParams = {}) =>
      client.get<DependantPage>(`/dependants${toQueryString(params)}`),
    createDependant: (body: CreateDependantRequest) => client.post<Dependant>('/dependants', body),
    getDependant: (dependantId: string) => client.get<Dependant>(`/dependants/${dependantId}`),
    getDependantStats: (dependantId: string) =>
      client.get<VisitStats>(`/dependants/${dependantId}/stats`),
    updateDependant: (dependantId: string, body: UpdateDependantRequest) =>
      client.patch<Dependant>(`/dependants/${dependantId}`, body),
    listFamilyMembers: (dependantId: string) =>
      client.get<DependantFamilyMember[]>(`/dependants/${dependantId}/family-members`),
    addFamilyMember: (dependantId: string, body: AddFamilyMemberRequest) =>
      client.post<DependantFamilyMember>(`/dependants/${dependantId}/family-members`, body),
    updateFamilyMember: (
      dependantId: string,
      familyMemberUserId: string,
      body: UpdateFamilyMemberRequest,
    ) =>
      client.patch<DependantFamilyMember>(
        `/dependants/${dependantId}/family-members/${familyMemberUserId}`,
        body,
      ),
    listCareTasks: (dependantId: string, active?: boolean) =>
      client.get<CareTask[]>(
        `/dependants/${dependantId}/care-tasks${active === undefined ? '' : `?active=${active}`}`,
      ),
    createCareTask: (dependantId: string, body: CreateCareTaskRequest) =>
      client.post<CareTask>(`/dependants/${dependantId}/care-tasks`, body),
    updateCareTask: (dependantId: string, careTaskId: string, body: UpdateCareTaskRequest) =>
      client.patch<CareTask>(`/dependants/${dependantId}/care-tasks/${careTaskId}`, body),
  };
}

export type DependantsApi = ReturnType<typeof createDependantsApi>;

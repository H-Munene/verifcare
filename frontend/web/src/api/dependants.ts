// Typed request/response shapes and calls for /dependants, matching
// backend/src/routes/dependants.ts's actual DependantResponse/DependantFamilyMemberResponse
// interfaces and backend/openapi.yaml exactly - not re-derived from scratch.

import type { ApiClient } from './client';

export type DependantStatus = 'active' | 'deactivated';
export type DependantGender = 'male' | 'female';

export interface Dependant {
  id: string;
  fullName: string;
  dob: string;
  gender: DependantGender | null;
  homeAddressText: string | null;
  geofenceLat: number;
  geofenceLng: number;
  geofenceRadiusMeters: number;
  cognitiveMonitoringEnabled: boolean;
  status: DependantStatus;
  registeredBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DependantPage {
  items: Dependant[];
  nextCursor: string | null;
}

export interface DependantFamilyMember {
  dependantId: string;
  familyMemberUserId: string;
  relationship: string | null;
  isPrimaryContact: boolean;
  addedBy: string;
  createdAt: string;
}

// Exactly one of cognitoSub/email must be set - cognitoSub links an existing Cognito identity;
// email creates a brand-new one from scratch (2026-09-14, see backend/openapi.yaml's
// AddFamilyMemberRequest for the full contract). Built by components/FamilyMemberResolver.tsx,
// not typed directly by hand in any page.
export interface AddFamilyMemberRequest {
  cognitoSub?: string;
  email?: string;
  phoneNumber: string;
  fullName: string;
  relationship?: string;
  isPrimaryContact?: boolean;
}

export interface CreateDependantRequest {
  fullName: string;
  dob: string;
  gender?: DependantGender;
  homeAddressText?: string;
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

export interface ListDependantsParams {
  status?: DependantStatus;
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
  };
}

export type DependantsApi = ReturnType<typeof createDependantsApi>;

// Typed request/response shapes and calls for /caregivers, matching
// backend/src/routes/caregivers.ts's actual CaregiverResponse interface and backend/openapi.yaml
// exactly - not re-derived from scratch. Mirrors api/dependants.ts's exact module shape.

import type { ApiClient } from './client';
import type { VisitStats } from './visitStats';

export type CaregiverIdType = 'national_id' | 'passport';
export type CaregiverGender = 'male' | 'female';
export type CaregiverOccupation = 'nurse' | 'community_health_worker' | 'caregiver';

export interface Caregiver {
  userId: string;
  fullName: string;
  email: string | null;
  phoneNumber: string | null;
  idType: CaregiverIdType | null;
  idNumber: string | null;
  dob: string | null;
  gender: CaregiverGender | null;
  occupation: CaregiverOccupation | null;
  employeeNumber: string | null;
  hireDate: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CaregiverPage {
  items: Caregiver[];
  nextCursor: string | null;
}

// employeeNumber/hireDate are deliberately absent here - the backend now auto-generates both at
// creation (server-generated "CG-0001" style number, registration date), with no way for the
// client to set either on POST. They remain settable via UpdateCaregiverRequest below. No
// cognitoSub either - POST /caregivers creates the Cognito identity itself (2026-09-22, HEZ-54) -
// a caregiver never self-registers, so a pre-existing Cognito account can never be assumed.
export interface CreateCaregiverRequest {
  fullName: string;
  email: string;
  phoneNumber: string;
  idType: CaregiverIdType;
  idNumber: string;
  dob: string;
  gender: CaregiverGender;
  occupation: CaregiverOccupation;
}

export interface UpdateCaregiverRequest {
  fullName?: string;
  email?: string;
  phoneNumber?: string;
  idType?: CaregiverIdType;
  idNumber?: string;
  dob?: string;
  gender?: CaregiverGender;
  occupation?: CaregiverOccupation;
  employeeNumber?: string;
  hireDate?: string;
  active?: boolean;
}

export interface ListCaregiversParams {
  active?: boolean;
  sort?: 'name' | '-name' | 'hireDate' | '-hireDate';
  cursor?: string;
  limit?: number;
}

function toQueryString(params: ListCaregiversParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function createCaregiversApi(client: ApiClient) {
  return {
    listCaregivers: (params: ListCaregiversParams = {}) =>
      client.get<CaregiverPage>(`/caregivers${toQueryString(params)}`),
    createCaregiver: (body: CreateCaregiverRequest) => client.post<Caregiver>('/caregivers', body),
    getCaregiver: (caregiverId: string) => client.get<Caregiver>(`/caregivers/${caregiverId}`),
    getCaregiverStats: (caregiverId: string) =>
      client.get<VisitStats>(`/caregivers/${caregiverId}/stats`),
    updateCaregiver: (caregiverId: string, body: UpdateCaregiverRequest) =>
      client.patch<Caregiver>(`/caregivers/${caregiverId}`, body),
  };
}

export type CaregiversApi = ReturnType<typeof createCaregiversApi>;

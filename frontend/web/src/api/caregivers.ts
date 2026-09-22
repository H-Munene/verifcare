// Typed request/response shapes and calls for /caregivers, matching
// backend/src/routes/caregivers.ts's actual CaregiverResponse interface and backend/openapi.yaml
// exactly - not re-derived from scratch. Mirrors api/dependants.ts's exact module shape.

import type { ApiClient } from './client';

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
// client to set either on POST. They remain settable via UpdateCaregiverRequest below.
export interface CreateCaregiverRequest {
  cognitoSub: string;
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
  cursor?: string;
  limit?: number;
}

// Raw Cognito attributes for an identity that exists in the user pool but has never been
// registered as a caregiver here - phoneNumber/fullName can be null if that Cognito identity
// never set those attributes (see the new GET /caregivers/cognito-lookup contract).
export interface CognitoLookupResult {
  cognitoSub: string;
  email: string;
  phoneNumber: string | null;
  fullName: string | null;
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
    updateCaregiver: (caregiverId: string, body: UpdateCaregiverRequest) =>
      client.patch<Caregiver>(`/caregivers/${caregiverId}`, body),
    lookupCognitoByEmail: (email: string) =>
      client.get<CognitoLookupResult>(
        `/caregivers/cognito-lookup?email=${encodeURIComponent(email)}`,
      ),
  };
}

export type CaregiversApi = ReturnType<typeof createCaregiversApi>;

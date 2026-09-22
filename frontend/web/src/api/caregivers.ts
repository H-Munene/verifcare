// Typed request/response shapes and calls for /caregivers, matching
// backend/src/routes/caregivers.ts's actual CaregiverResponse interface and backend/openapi.yaml
// exactly - not re-derived from scratch. Mirrors api/dependants.ts's exact module shape.

import type { ApiClient } from './client';

export interface Caregiver {
  userId: string;
  fullName: string;
  phoneNumber: string | null;
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

export interface CreateCaregiverRequest {
  cognitoSub: string;
  phoneNumber: string;
  fullName: string;
  employeeNumber?: string;
  hireDate?: string;
}

export interface UpdateCaregiverRequest {
  phoneNumber?: string;
  fullName?: string;
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

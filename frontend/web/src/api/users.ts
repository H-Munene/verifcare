// Typed calls for /users, matching backend/src/routes/users.ts's UserResponse shape exactly.

import type { ApiClient } from './client';

export interface User {
  id: string;
  cognitoSub: string;
  email: string | null;
  phoneNumber: string | null;
  fullName: string;
  role: 'supervisor' | 'caregiver' | 'family_member';
  status: 'active' | 'suspended' | 'deactivated';
  createdAt: string;
  updatedAt: string;
}

export interface UserPage {
  items: User[];
  nextCursor: string | null;
}

export interface SearchUsersParams {
  email?: string;
  phoneNumber?: string;
}

function toQueryString(params: SearchUsersParams): string {
  const search = new URLSearchParams();
  if (params.email) {
    search.set('email', params.email);
  }
  if (params.phoneNumber) {
    search.set('phoneNumber', params.phoneNumber);
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function createUsersApi(client: ApiClient) {
  return {
    /** The signed-in person's own record (GET /users/me). */
    getMe: () => client.get<User>('/users/me'),
    getUser: (userId: string) => client.get<User>(`/users/${userId}`),
    // Exact-match search (email XOR phoneNumber) - both columns are UNIQUE in the DB, so this
    // returns at most one result. Added 2026-09-14 so a supervisor can look up an existing user
    // instead of needing their internal id or Cognito sub already (see
    // components/FamilyMemberResolver.tsx, the caller of this).
    searchUsers: (params: SearchUsersParams) =>
      client.get<UserPage>(`/users${toQueryString(params)}`),
  };
}

export type UsersApi = ReturnType<typeof createUsersApi>;

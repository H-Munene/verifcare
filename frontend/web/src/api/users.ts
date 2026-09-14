// Typed calls for /users, matching backend/src/routes/users.ts's UserResponse shape exactly.
// Only what this app currently needs (looking up a family member's display name from their
// internal user id) - not the full /users surface.

import type { ApiClient } from './client';

export interface User {
  id: string;
  email: string | null;
  phoneNumber: string | null;
  fullName: string;
  role: 'supervisor' | 'caregiver' | 'family_member';
  status: 'active' | 'suspended' | 'deactivated';
  createdAt: string;
  updatedAt: string;
}

export function createUsersApi(client: ApiClient) {
  return {
    getUser: (userId: string) => client.get<User>(`/users/${userId}`),
  };
}

export type UsersApi = ReturnType<typeof createUsersApi>;

import { useMemo } from 'react';
import { useAuth } from '../auth/AuthContext';
import { createBiometricEnrollmentsApi } from './biometricEnrollments';
import { createApiClient } from './client';
import { createDependantsApi } from './dependants';
import { createUsersApi } from './users';

// One place that wires the authenticated ApiClient into each resource's typed calls - every
// future resource module (caregivers, visit-schedules, ...) gets added here, not re-wired per
// page.
export function useApi() {
  const { getIdToken } = useAuth();
  const client = useMemo(() => createApiClient(getIdToken), [getIdToken]);
  const dependants = useMemo(() => createDependantsApi(client), [client]);
  const users = useMemo(() => createUsersApi(client), [client]);
  const biometricEnrollments = useMemo(() => createBiometricEnrollmentsApi(client), [client]);
  return { dependants, users, biometricEnrollments };
}

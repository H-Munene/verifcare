import { useMemo } from 'react';
import { useAuth } from '../auth/AuthContext';
import { createBiometricEnrollmentsApi } from './biometricEnrollments';
import { createCaregiversApi } from './caregivers';
import { createApiClient } from './client';
import { createDashboardApi } from './dashboard';
import { createDependantsApi } from './dependants';
import { createUsersApi } from './users';
import { createVisitSchedulesApi } from './visitSchedules';

// One place that wires the authenticated ApiClient into each resource's typed calls - every
// future resource module gets added here, not re-wired per page.
export function useApi() {
  const { getIdToken } = useAuth();
  const client = useMemo(() => createApiClient(getIdToken), [getIdToken]);
  const dependants = useMemo(() => createDependantsApi(client), [client]);
  const caregivers = useMemo(() => createCaregiversApi(client), [client]);
  const users = useMemo(() => createUsersApi(client), [client]);
  const biometricEnrollments = useMemo(() => createBiometricEnrollmentsApi(client), [client]);
  const visitSchedules = useMemo(() => createVisitSchedulesApi(client), [client]);
  const dashboard = useMemo(() => createDashboardApi(client), [client]);
  return { dependants, caregivers, users, biometricEnrollments, visitSchedules, dashboard };
}

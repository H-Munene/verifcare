import { useMemo } from 'react';
import { useAuth } from '../auth/AuthContext';
import { createApiClient } from './client';
import { createDependantsApi } from './dependants';
import { createUsersApi } from './users';

// Binds the authenticated ApiClient to each resource's calls.
export function useApi() {
  const { getIdToken } = useAuth();
  const client = useMemo(() => createApiClient(getIdToken), [getIdToken]);
  const dependants = useMemo(() => createDependantsApi(client), [client]);
  const users = useMemo(() => createUsersApi(client), [client]);
  return { dependants, users };
}

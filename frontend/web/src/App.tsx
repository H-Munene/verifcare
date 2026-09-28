import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { AppShell } from './components/AppShell';
import { DependantDetailPage } from './pages/DependantDetailPage';
import { DependantsListPage } from './pages/DependantsListPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterDependantPage } from './pages/RegisterDependantPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <AppShell>
              <Routes>
                <Route path="/" element={<Navigate to="/dependants" replace />} />
                <Route path="/dependants" element={<DependantsListPage />} />
                <Route path="/dependants/new" element={<RegisterDependantPage />} />
                <Route path="/dependants/:dependantId" element={<DependantDetailPage />} />
                <Route path="/dependants/:dependantId/edit" element={<RegisterDependantPage />} />
              </Routes>
            </AppShell>
          </RequireAuth>
        }
      />
    </Routes>
  );
}

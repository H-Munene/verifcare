import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
import { AppShell } from './components/AppShell';
import { CarePlanPage } from './pages/CarePlanPage';
import { CaregiverDetailPage } from './pages/CaregiverDetailPage';
import { CaregiversListPage } from './pages/CaregiversListPage';
import { DependantDetailPage } from './pages/DependantDetailPage';
import { DependantsListPage } from './pages/DependantsListPage';
import { FlaggedEnrollmentsPage } from './pages/FlaggedEnrollmentsPage';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { RegisterCaregiverPage } from './pages/RegisterCaregiverPage';
import { RegisterDependantPage } from './pages/RegisterDependantPage';
import { VisitDetailPage } from './pages/VisitDetailPage';
import { VisitsPage } from './pages/VisitsPage';

// The Overview is the supervisor console's landing page (as in the admin wireframes), and its data
// is supervisor-only, so anyone else lands on Dependants instead.
function SupervisorOverview() {
  const { identity } = useAuth();
  return identity?.role === 'supervisor' ? <OverviewPage /> : <Navigate to="/dependants" replace />;
}

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
                <Route path="/" element={<Navigate to="/overview" replace />} />
                <Route path="/overview" element={<SupervisorOverview />} />
                <Route path="/dependants" element={<DependantsListPage />} />
                <Route path="/dependants/new" element={<RegisterDependantPage />} />
                <Route path="/dependants/:dependantId" element={<DependantDetailPage />} />
                <Route path="/dependants/:dependantId/edit" element={<RegisterDependantPage />} />
                <Route path="/dependants/:dependantId/care-plan" element={<CarePlanPage />} />
                <Route path="/caregivers" element={<CaregiversListPage />} />
                <Route path="/caregivers/new" element={<RegisterCaregiverPage />} />
                <Route path="/caregivers/:caregiverId" element={<CaregiverDetailPage />} />
                <Route path="/caregivers/:caregiverId/edit" element={<RegisterCaregiverPage />} />
                <Route path="/visits" element={<VisitsPage />} />
                <Route path="/visits/:visitId" element={<VisitDetailPage />} />
                <Route path="/reviews" element={<FlaggedEnrollmentsPage />} />
                {/* The page's address before it became the Reviews section. */}
                <Route path="/flagged-enrollments" element={<Navigate to="/reviews" replace />} />
              </Routes>
            </AppShell>
          </RequireAuth>
        }
      />
    </Routes>
  );
}

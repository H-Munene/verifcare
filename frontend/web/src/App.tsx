import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth/RequireAuth';
import { AppShell } from './components/AppShell';
import { CarePlanPage } from './pages/CarePlanPage';
import { CaregiverDetailPage } from './pages/CaregiverDetailPage';
import { CaregiversListPage } from './pages/CaregiversListPage';
import { DependantDetailPage } from './pages/DependantDetailPage';
import { DependantsListPage } from './pages/DependantsListPage';
import { FlaggedEnrollmentsPage } from './pages/FlaggedEnrollmentsPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterCaregiverPage } from './pages/RegisterCaregiverPage';
import { RegisterDependantPage } from './pages/RegisterDependantPage';
import { VisitDetailPage } from './pages/VisitDetailPage';
import { VisitsPage } from './pages/VisitsPage';

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
                <Route path="/dependants/:dependantId/care-plan" element={<CarePlanPage />} />
                <Route path="/caregivers" element={<CaregiversListPage />} />
                <Route path="/caregivers/new" element={<RegisterCaregiverPage />} />
                <Route path="/caregivers/:caregiverId" element={<CaregiverDetailPage />} />
                <Route path="/caregivers/:caregiverId/edit" element={<RegisterCaregiverPage />} />
                <Route path="/visits" element={<VisitsPage />} />
                <Route path="/visits/:visitId" element={<VisitDetailPage />} />
                <Route path="/flagged-enrollments" element={<FlaggedEnrollmentsPage />} />
              </Routes>
            </AppShell>
          </RequireAuth>
        }
      />
    </Routes>
  );
}

import { Routes, Route, useSearchParams } from 'react-router-dom';
import { ProtectedRoute } from '../components/auth/ProtectedRoute.jsx';
import { AdminRoute } from '../components/auth/AdminRoute.jsx';
import LandingPage from '../pages/public/LandingPage.jsx';
import LoginPage from '../pages/auth/LoginPage.jsx';
import SignupPage from '../pages/auth/SignupPage.jsx';
import ForgotPasswordPage from '../pages/auth/ForgotPasswordPage.jsx';
import ResetPasswordPage from '../pages/auth/ResetPasswordPage.jsx';
import AdminDashboardPage from '../pages/admin/AdminDashboardPage.jsx';
import AdminUploadPage from '../pages/admin/AdminUploadPage.jsx';
import AdminContentPage from '../pages/admin/AdminContentPage.jsx';
import AdminStudentsPage from '../pages/admin/AdminStudentsPage.jsx';
import AdminAuditPage from '../pages/admin/AdminAuditPage.jsx';
import FreeResources from '../pages/public/FreeResources.jsx';
import ProfilePage from '../pages/dashboard/ProfilePage.jsx';
import RecursosPage from '../pages/dashboard/RecursosPage.jsx';

const Dashboard = () => {
  const [searchParams] = useSearchParams();
  const reason = searchParams.get('reason');

  return (
    <div className="page-shell">
      {reason === 'forbidden' && (
        <div className="error-message">
          No tienes permisos para acceder a esa sección.
        </div>
      )}
      <h1>Dashboard</h1>
      <p>Bienvenido al dashboard. Próximamente: galería de contenido.</p>
    </div>
  );
};

const NotFoundPage = () => (
  <div className="page-shell">
    <h1>404 - Página no encontrada</h1>
    <a href="/" className="button button-primary">Volver a inicio</a>
  </div>
);

export const AppRoutes = () => (
  <Routes>
    <Route path="/" element={<LandingPage />} />
    <Route path="/auth/login" element={<LoginPage />} />
    <Route path="/auth/signup" element={<SignupPage />} />
    <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
    <Route path="/auth/reset-password" element={<ResetPasswordPage />} />

    <Route
      path="/dashboard"
      element={
        <ProtectedRoute>
          <Dashboard />
        </ProtectedRoute>
      }
    />
    <Route
      path="/profile"
      element={
        <ProtectedRoute>
          <ProfilePage />
        </ProtectedRoute>
      }
    />
    <Route
      path="/recursos"
      element={
        <ProtectedRoute>
          <RecursosPage />
        </ProtectedRoute>
      }
    />
    <Route
      path="/free"
      element={
        <ProtectedRoute>
          <FreeResources />
        </ProtectedRoute>
      }
    />

    <Route
      path="/admin"
      element={
        <ProtectedRoute>
          <AdminRoute>
            <AdminDashboardPage />
          </AdminRoute>
        </ProtectedRoute>
      }
    />
    <Route
      path="/admin/upload"
      element={
        <ProtectedRoute>
          <AdminRoute>
            <AdminUploadPage />
          </AdminRoute>
        </ProtectedRoute>
      }
    />
    <Route
      path="/admin/content"
      element={
        <ProtectedRoute>
          <AdminRoute>
            <AdminContentPage />
          </AdminRoute>
        </ProtectedRoute>
      }
    />
    <Route
      path="/admin/students"
      element={
        <ProtectedRoute>
          <AdminRoute>
            <AdminStudentsPage />
          </AdminRoute>
        </ProtectedRoute>
      }
    />
    <Route
      path="/admin/audit"
      element={<ProtectedRoute><AdminRoute><AdminAuditPage /></AdminRoute></ProtectedRoute>}
    />

    <Route path="*" element={<NotFoundPage />} />
  </Routes>
);

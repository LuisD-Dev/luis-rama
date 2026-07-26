import { BrowserRouter as Router } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.jsx';
import { ContentProvider } from './context/ContentContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import { Navbar } from './components/common/Navbar.jsx';
import { SessionToast, useSessionToast } from './components/common/SessionToast.jsx';
import { ErrorBoundary } from './components/common/ErrorBoundary.jsx';
import { InactivityModal } from './components/common/InactivityModal.jsx';
import { useInactivityTimer } from './hooks/useInactivityTimer.js';
import { AppRoutes } from './routes/index.jsx';
import { useAuth } from './hooks/useAuth.js';

const AppShellContent = () => {
  const { user, logout } = useAuth();

  const handleTimeout = () => {
    logout({ reason: 'expired', redirectTo: '/auth/login' });
  };

  const { showWarning, dismissWarning } = useInactivityTimer(handleTimeout, !!user);

  return (
    <>
      <AppRoutes />
      {showWarning && (
        <InactivityModal
          onDismiss={dismissWarning}
          onLogout={() => logout({ redirectTo: '/auth/login' })}
        />
      )}
    </>
  );
};

const AppShell = () => {
  const { toast, showSessionExpiredToast, dismissToast } = useSessionToast();

  return (
    <ErrorBoundary>
      <AuthProvider onSessionExpiredToast={showSessionExpiredToast}>
        <ContentProvider>
          <ToastProvider>
            <Navbar />
            <SessionToast
              message={toast.message}
              visible={toast.visible}
              onDismiss={dismissToast}
            />
            <AppShellContent />
          </ToastProvider>
        </ContentProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
};

function App() {
  return (
    <Router>
      <AppShell />
    </Router>
  );
}

export default App;

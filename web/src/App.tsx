import { type ReactNode } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';

import { queryClient } from './lib/query';
import { AuthProvider, useAuth } from './lib/auth-context';
import { RealtimeListener } from './lib/sse';
import { useSetupStatus } from './api/setup';
import { AppShell } from './components/layout/AppShell';
import { TooltipProvider } from './components/ui';
import { FullPageSpinner } from './components/ui/Spinner';

import SetupPage from './pages/Setup';
import LoginPage from './pages/Login';
import RegisterPage from './pages/Register';
import BoardPage from './pages/BoardPage';
import ProjectsPage from './pages/ProjectsPage';
import IdeasPage from './pages/IdeasPage';
import StatsPage from './pages/StatsPage';
import AdminPage from './pages/AdminPage';
import AccountProfilePage from './pages/AccountProfile';

/**
 * App root (§4). Wires providers (Query → Auth → Tooltip), mounts the realtime
 * listener for authenticated sessions, and defines the route table with guards
 * (§8): unauthenticated → /login; first-run (no users) → /setup; /admin requires
 * a global admin.
 */

/**
 * Gate for authenticated areas. While auth/setup status is loading, render a
 * spinner. If the instance still needs setup and nobody is logged in, send the
 * user to /setup. Otherwise, unauthenticated users go to /login.
 */
function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();
  // Only check setup state when there's no session yet (cheap, cached forever).
  const setupStatus = useSetupStatus({ enabled: !isAuthenticated && !loading });

  if (loading) {
    return <FullPageSpinner />;
  }

  if (!isAuthenticated) {
    if (setupStatus.isLoading) {
      return <FullPageSpinner />;
    }
    if (setupStatus.data?.needsSetup) {
      return <Navigate to="/setup" replace />;
    }
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

/** Admin-only gate (§6.3). Assumes it is nested inside RequireAuth. */
function RequireAdmin({ children }: { children: ReactNode }): JSX.Element {
  const { isAdmin } = useAuth();
  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

/**
 * Public route gate — redirects already-authenticated users away from /login and
 * /setup back into the app.
 */
function PublicOnly({ children }: { children: ReactNode }): JSX.Element {
  const { isAuthenticated, loading } = useAuth();
  if (loading) {
    return <FullPageSpinner />;
  }
  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

/** Index route: the board defaults to the All-Projects view (§8). */
function HomeRedirect(): JSX.Element {
  return <Navigate to="/board/all" replace />;
}

function AuthedRoutes(): JSX.Element {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/board/:projectId" element={<BoardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/ideas" element={<IdeasPage />} />
        <Route path="/stats" element={<StatsPage />} />
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <AdminPage />
            </RequireAdmin>
          }
        />
        {/* Account self-service (avatar / name / password) lives under the shell. */}
        {/* Old bookmark: 修改密码 now lives inside the profile page. */}
        <Route
          path="/account/password"
          element={<Navigate to="/account/profile" replace />}
        />
        <Route path="/account/profile" element={<AccountProfilePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

function AppRoutes(): JSX.Element {
  return (
    <Routes>
      <Route
        path="/setup"
        element={
          <PublicOnly>
            <SetupPage />
          </PublicOnly>
        }
      />
      <Route
        path="/login"
        element={
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        }
      />
      <Route
        path="/register"
        element={
          <PublicOnly>
            <RegisterPage />
          </PublicOnly>
        }
      />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <RealtimeListener />
            <AuthedRoutes />
          </RequireAuth>
        }
      />
    </Routes>
  );
}

export default function App(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

import { Loader2 } from 'lucide-react';
import VerifyEmailPage from './pages/VerifyEmailPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import SignupPage from './pages/SignupPage';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import PlansPage from './pages/PlansPage';
import { AuthProvider, useAuth } from './auth';

// Account + billing app for /v1/api/auth/* and /v1/api/billing/* — signup,
// login, password reset/verify (the 2 emailed-link destinations this app
// started as — see git history), and the subscription/plan management UI.
// Plain pathname routing (no router library), matching the rest of this
// monorepo's apps (admin-console, developer-portal, checkout) — each path
// is its own top-level destination with full navigations between them.
function Router() {
  const { isAuthenticated, loading } = useAuth();
  const path = window.location.pathname;

  // Emailed-link + unauthenticated destinations never require a session.
  if (path === '/reset-password') return <ResetPasswordPage />;
  if (path === '/verify-email') return <VerifyEmailPage />;
  if (path === '/forgot-password') return <ForgotPasswordPage />;
  if (path === '/signup') return isAuthenticated ? <DashboardPage /> : <SignupPage />;
  if (path === '/login') return isAuthenticated ? <DashboardPage /> : <LoginPage />;

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 style={{ width: '24px', height: '24px', animation: 'spin 1s linear infinite', color: 'var(--text-muted)' }} />
      </div>
    );
  }

  if (!isAuthenticated) {
    // Unrecognized path while signed out — a stray token-bearing link is
    // still more likely than a real 404 (see VerifyEmailPage's default),
    // but '/' and '/plans' specifically mean "take me to my account", so
    // send those to sign-in instead of defaulting to the verify-email page.
    return <LoginPage />;
  }

  if (path === '/plans') return <PlansPage />;
  return <DashboardPage />;
}

export default function App() {
  return (
    <AuthProvider>
      <Router />
    </AuthProvider>
  );
}

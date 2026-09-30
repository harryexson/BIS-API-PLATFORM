import VerifyEmailPage from './pages/VerifyEmailPage';
import ResetPasswordPage from './pages/ResetPasswordPage';

// This app is deliberately just the 2 emailed-link destinations
// (verify-email, reset-password) that services/api-gateway/src/app.ts's
// sendAccountEmail()/buildAccountLink() point PLATFORM_APP_URL at — see
// VerifyEmailPage.tsx and ResetPasswordPage.tsx for the routes they call.
// The old branch's own apps/web also carried a full marketing landing page
// (Nav/Hero/Features/Pricing/Footer) at this same app, but that content is
// superseded by this repo's separate, already-redesigned apps/landing —
// porting it here too would just create a second, conflicting marketing
// site. Plain pathname-based routing (no router library) matches how
// AccountLayout/vercel.json expect this app to be reached: each path is a
// standalone destination with no navigation between them.
export default function App() {
  const path = window.location.pathname;
  if (path === '/reset-password') return <ResetPasswordPage />;
  // Default (including '/verify-email' itself, and any unrecognized path)
  // — this app's whole job is these 2 pages, and a stray token-bearing
  // link is far more likely than a real 404 here.
  return <VerifyEmailPage />;
}

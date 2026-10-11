import type { ReactNode } from 'react';
import { Network, LogOut } from 'lucide-react';
import { useAuth } from './auth';

// Signed-in chrome (Dashboard, Plans) — wider than AccountLayout's centered
// card, with a top nav for moving between the two authenticated pages and
// signing out.
export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const path = window.location.pathname;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-subtle)' }}>
      <header style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
        <div className="container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: '72px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '36px' }}>
            <a href="/" style={{ display: 'flex', alignItems: 'center', gap: '10px', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '17px', color: 'var(--text)', textDecoration: 'none' }}>
              <div style={{ width: '34px', height: '34px', borderRadius: '10px', background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Network style={{ color: 'white', width: '17px', height: '17px' }} />
              </div>
              BIS API Platform
            </a>
            <nav style={{ display: 'flex', gap: '24px' }}>
              <a href="/" style={{ fontSize: '14px', fontWeight: 600, textDecoration: 'none', color: path === '/' ? 'var(--text)' : 'var(--text-secondary)' }}>
                Dashboard
              </a>
              <a href="/plans" style={{ fontSize: '14px', fontWeight: 600, textDecoration: 'none', color: path === '/plans' ? 'var(--text)' : 'var(--text-secondary)' }}>
                Plans & Billing
              </a>
            </nav>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {user && (
              <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>{user.email}</span>
            )}
            <button
              onClick={logout}
              className="btn btn-secondary"
              style={{ padding: '9px 16px', fontSize: '14px', borderRadius: '10px', display: 'flex', alignItems: 'center', gap: '8px' }}
            >
              <LogOut style={{ width: '15px', height: '15px' }} />
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main style={{ flex: 1 }}>
        <div className="container" style={{ padding: '40px 28px' }}>{children}</div>
      </main>
    </div>
  );
}

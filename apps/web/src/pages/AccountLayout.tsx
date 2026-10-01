import type { ReactNode } from 'react';
import { Network } from 'lucide-react';

// Minimal shared chrome for the account pages (verify-email, reset-password)
// — these are single-purpose landing spots for an emailed link, not part of
// the marketing site's nav/scroll flow, so they get their own small layout
// rather than reusing <Nav>/<Footer>.
export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="container" style={{ display: 'flex', alignItems: 'center', gap: '10px', minHeight: '76px' }}>
          <a href="/" style={{ display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '18px', color: 'var(--text)' }}>
            <div style={{ width: '38px', height: '38px', borderRadius: '11px', background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Network style={{ color: 'white', width: '19px', height: '19px' }} />
            </div>
            BIS API Platform
          </a>
        </div>
      </header>
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 20px' }}>
        <div className="card" style={{ width: '100%', maxWidth: '440px' }}>{children}</div>
      </main>
    </div>
  );
}

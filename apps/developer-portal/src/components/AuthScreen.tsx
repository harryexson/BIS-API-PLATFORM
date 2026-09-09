import { useState } from 'react';
import { usePortalAuth } from '../auth';

export default function AuthScreen() {
  const { login, signup, completeSignup } = usePortalAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('signup');
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Signup deliberately does NOT flip global auth state itself — otherwise the
  // parent immediately swaps this whole screen out for the dashboard before
  // the one-time API key ever has a chance to render. completeSignup() is
  // what actually authenticates, once the user has acknowledged the key.
  const [pendingSignup, setPendingSignup] = useState<{
    apiKey?: { prefix: string; raw: string };
    token: string;
    application: { id: string; name: string; slug: string };
  } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    if (mode === 'signup') {
      const result = await signup({ companyName, email, password });
      setBusy(false);
      if (!result.ok) return setError(result.error || 'Something went wrong');
      if (result.token && result.application) {
        setPendingSignup({ apiKey: result.apiKey, token: result.token, application: result.application });
      }
    } else {
      const result = await login({ email, password });
      setBusy(false);
      if (!result.ok) return setError(result.error || 'Something went wrong');
    }
  }

  if (pendingSignup) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <div className="glass-card" style={{ width: 440 }}>
          <h2 style={{ marginTop: 0 }}>Your API key</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
            This is shown once — copy it now. You can create more keys later from the dashboard.
          </p>
          <div style={{ background: 'var(--bg-secondary)', padding: 12, borderRadius: 8, fontFamily: 'var(--font-mono)', fontSize: 13, wordBreak: 'break-all', marginBottom: 16 }}>
            {pendingSignup.apiKey?.raw}
          </div>
          <button
            className="btn-primary"
            style={{ width: '100%' }}
            onClick={() => completeSignup(pendingSignup.token, pendingSignup.application)}
          >
            Continue to dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={submit} className="glass-card" style={{ width: 380 }}>
        <h1 style={{ marginTop: 0, fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}>BIS API Platform</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: -8, fontSize: 14 }}>Developer Portal</p>

        {mode === 'signup' && (
          <>
            <label style={{ display: 'block', margin: '16px 0 6px', fontSize: 13, color: 'var(--text-secondary)' }}>Company name</label>
            <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} required placeholder="Reach Church" />
          </>
        )}

        <label style={{ display: 'block', margin: '16px 0 6px', fontSize: 13, color: 'var(--text-secondary)' }}>Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@company.com" />

        <label style={{ display: 'block', margin: '16px 0 6px', fontSize: 13, color: 'var(--text-secondary)' }}>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} placeholder="At least 8 characters" />

        {error && <p style={{ color: 'var(--accent-red)', fontSize: 13, marginBottom: 0 }}>{error}</p>}

        <button className="btn-primary" type="submit" disabled={busy} style={{ width: '100%', marginTop: 20 }}>
          {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>

        <p style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 0 }}>
          {mode === 'signup' ? 'Already have an account?' : "Don't have an account?"}{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'signup' ? 'login' : 'signup'); setError(null); }} style={{ color: 'var(--accent-cyan)' }}>
            {mode === 'signup' ? 'Sign in' : 'Create one'}
          </a>
        </p>
      </form>
    </div>
  );
}

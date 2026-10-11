import { useState, type CSSProperties, type FormEvent } from 'react';
import AccountLayout from './AccountLayout';
import { useAuth } from '../auth';

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await login({ email, password });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    window.location.href = '/';
  }

  return (
    <AccountLayout>
      <div style={{ textAlign: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '22px', fontWeight: 700, margin: '0 0 10px' }}>Sign in</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '15px', lineHeight: 1.6, margin: 0 }}>
          Welcome back — sign in to manage your plan and API keys.
        </p>
      </div>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>
          Email
          <input
            type="email"
            required
            value={email}
            placeholder="you@company.com"
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
        </label>
        {error && <p style={{ color: '#dc2626', fontSize: '14px', margin: 0 }}>{error}</p>}
        <div style={{ textAlign: 'right' }}>
          <a href="/forgot-password" style={{ fontSize: '13px', color: 'var(--accent-2)', fontWeight: 600 }}>Forgot password?</a>
        </div>
        <button type="submit" className="btn btn-primary" disabled={submitting} style={{ width: '100%', marginTop: '2px' }}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        <p style={{ textAlign: 'center', fontSize: '14px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
          Don't have an account? <a href="/signup" style={{ color: 'var(--accent-2)', fontWeight: 600 }}>Create one</a>
        </p>
      </form>
    </AccountLayout>
  );
}

const inputStyle: CSSProperties = {
  padding: '12px 14px',
  borderRadius: '10px',
  border: '1px solid var(--border-strong)',
  fontSize: '15px',
  fontFamily: 'inherit',
  color: 'var(--text)',
  outline: 'none',
};

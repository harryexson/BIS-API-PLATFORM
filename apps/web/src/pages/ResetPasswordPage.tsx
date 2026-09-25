import { useState, type FormEvent, type ReactNode } from 'react';
import { CheckCircle2, XCircle, Lock } from 'lucide-react';
import AccountLayout from './AccountLayout';

const MIN_PASSWORD_LENGTH = 8; // mirrors packages/database/src/auth-registry.ts's MIN_PASSWORD_LENGTH

type Status = 'form' | 'submitting' | 'success' | 'error' | 'missing-token';

// Lands the /reset-password?token=... link services/api-gateway/src/app.ts's
// sendAccountEmail() sends, and calls the real, already-existing
// POST /v1/api/auth/reset-password — see VerifyEmailPage.tsx's comment for
// the same story on the verify-email side.
export default function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token');
  const [status, setStatus] = useState<Status>(token ? 'form' : 'missing-token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setError(null);
    setStatus('submitting');
    try {
      const res = await fetch('/v1/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Password reset failed');
      setStatus('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password reset failed');
      setStatus('error');
    }
  }

  if (status === 'missing-token') {
    return (
      <AccountLayout>
        <Centered
          icon={<XCircle className="w-6 h-6" style={{ color: '#dc2626' }} />}
          title="Missing reset link"
          body="This page needs a reset token — open it from the link in your email instead of visiting it directly."
        />
      </AccountLayout>
    );
  }

  if (status === 'success') {
    return (
      <AccountLayout>
        <Centered
          icon={<CheckCircle2 className="w-6 h-6" style={{ color: '#16a34a' }} />}
          title="Password reset"
          body="Your password has been changed. Any existing sessions were signed out — sign in again with your new password in your application."
        />
      </AccountLayout>
    );
  }

  return (
    <AccountLayout>
      <div style={{ textAlign: 'center', marginBottom: '24px' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '56px', height: '56px', borderRadius: '16px', background: 'var(--bg-subtle)', marginBottom: '20px' }}>
          <Lock className="w-6 h-6" style={{ color: 'var(--accent-2)' }} />
        </div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '22px', fontWeight: 700, margin: '0 0 10px' }}>Set a new password</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '15px', lineHeight: 1.6, margin: 0 }}>Choose a new password for your account.</p>
      </div>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <Field label="New password" value={password} onChange={setPassword} />
        <Field label="Confirm new password" value={confirm} onChange={setConfirm} />
        {error && <p style={{ color: '#dc2626', fontSize: '14px', margin: 0 }}>{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={status === 'submitting'} style={{ width: '100%', marginTop: '6px' }}>
          {status === 'submitting' ? 'Resetting…' : 'Reset password'}
        </button>
      </form>
    </AccountLayout>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>
      {label}
      <input
        type="password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: '12px 14px',
          borderRadius: '10px',
          border: '1px solid var(--border-strong)',
          fontSize: '15px',
          fontFamily: 'inherit',
          color: 'var(--text)',
          outline: 'none',
        }}
      />
    </label>
  );
}

function Centered({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '56px', height: '56px', borderRadius: '16px', background: 'var(--bg-subtle)', marginBottom: '20px' }}>
        {icon}
      </div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '22px', fontWeight: 700, margin: '0 0 10px' }}>{title}</h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: '15px', lineHeight: 1.6, margin: 0 }}>{body}</p>
    </div>
  );
}

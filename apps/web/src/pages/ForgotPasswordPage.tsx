import { useState, type FormEvent } from 'react';
import { MailCheck } from 'lucide-react';
import AccountLayout from './AccountLayout';

// Entry form for POST /v1/api/auth/request-password-reset — the emailed
// link it triggers lands on ResetPasswordPage.tsx.
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch('/v1/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await res.json().catch(() => ({}));
      // Always a generic success — the endpoint never reveals whether the
      // account exists.
      setSent(true);
      if (body.passwordResetToken) setDevToken(body.passwordResetToken);
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <AccountLayout>
        <div style={{ textAlign: 'center' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '56px', height: '56px', borderRadius: '16px', background: 'var(--bg-subtle)', marginBottom: '20px' }}>
            <MailCheck className="w-6 h-6" style={{ color: 'var(--accent-2)' }} />
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '22px', fontWeight: 700, margin: '0 0 10px' }}>Check your email</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '15px', lineHeight: 1.6, margin: 0 }}>
            If an account exists for {email}, a password reset link has been sent.
          </p>
          {devToken && (
            <p style={{ marginTop: '16px', fontSize: '13px' }}>
              <a href={`/reset-password?token=${devToken}`} style={{ color: 'var(--accent-2)', fontWeight: 600 }}>
                Dev mode: open reset link directly
              </a>
            </p>
          )}
        </div>
      </AccountLayout>
    );
  }

  return (
    <AccountLayout>
      <div style={{ textAlign: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '22px', fontWeight: 700, margin: '0 0 10px' }}>Reset your password</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '15px', lineHeight: 1.6, margin: 0 }}>
          Enter your email and we'll send you a link to reset your password.
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
            style={{ padding: '12px 14px', borderRadius: '10px', border: '1px solid var(--border-strong)', fontSize: '15px', fontFamily: 'inherit', color: 'var(--text)', outline: 'none' }}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={submitting} style={{ width: '100%', marginTop: '6px' }}>
          {submitting ? 'Sending…' : 'Send reset link'}
        </button>
        <p style={{ textAlign: 'center', fontSize: '14px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
          <a href="/login" style={{ color: 'var(--accent-2)', fontWeight: 600 }}>Back to sign in</a>
        </p>
      </form>
    </AccountLayout>
  );
}

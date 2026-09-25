import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import AccountLayout from './AccountLayout';

type Status = 'verifying' | 'success' | 'error' | 'missing-token';

// Lands the /verify-email?token=... link services/api-gateway/src/app.ts's
// sendAccountEmail() sends, and calls the real, already-existing
// POST /v1/api/auth/verify-email — that endpoint just had no page to be
// linked from before this (see docs/IMPLEMENTATION_BASELINE.md item 15).
export default function VerifyEmailPage() {
  const [status, setStatus] = useState<Status>('verifying');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setStatus('missing-token');
      return;
    }
    fetch('/v1/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Verification failed');
        setStatus('success');
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Verification failed');
        setStatus('error');
      });
  }, []);

  return (
    <AccountLayout>
      {status === 'verifying' && (
        <Centered icon={<Loader2 className="w-6 h-6" style={{ animation: 'spin 1s linear infinite' }} />} title="Verifying your email…" body="This will only take a moment." />
      )}
      {status === 'success' && (
        <Centered
          icon={<CheckCircle2 className="w-6 h-6" style={{ color: '#16a34a' }} />}
          title="Email verified"
          body="Your email address has been confirmed. You can close this page and continue in your application."
        />
      )}
      {status === 'missing-token' && (
        <Centered
          icon={<XCircle className="w-6 h-6" style={{ color: '#dc2626' }} />}
          title="Missing verification link"
          body="This page needs a verification token — open it from the link in your email instead of visiting it directly."
        />
      )}
      {status === 'error' && (
        <Centered
          icon={<XCircle className="w-6 h-6" style={{ color: '#dc2626' }} />}
          title="Verification failed"
          body={error || 'This link may have expired or already been used. Request a new verification email and try again.'}
        />
      )}
    </AccountLayout>
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

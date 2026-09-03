import { useEffect, useState } from 'react';

interface SessionInfo {
  id: string;
  status: 'pending' | 'completed' | 'expired';
  amount: number;
  currency: string;
  applicationName: string;
}

type ViewState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; session: SessionInfo }
  | { phase: 'paying'; session: SessionInfo }
  | { phase: 'success'; successUrl: string | null }
  | { phase: 'failed'; cancelUrl: string | null };

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

export default function App() {
  const token = new URLSearchParams(window.location.search).get('session');
  const [state, setState] = useState<ViewState>({ phase: 'loading' });
  const [paymentMethod, setPaymentMethod] = useState('card');

  useEffect(() => {
    if (!token) {
      setState({ phase: 'error', message: 'No checkout session specified. Missing ?session= in the URL.' });
      return;
    }
    fetch(`/v1/checkout/sessions/${token}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Checkout session not found');
        return res.json() as Promise<SessionInfo>;
      })
      .then((session) => {
        if (session.status !== 'pending') {
          setState({ phase: 'error', message: `This checkout link has already been ${session.status}.` });
        } else {
          setState({ phase: 'ready', session });
        }
      })
      .catch((err) => setState({ phase: 'error', message: err.message }));
  }, [token]);

  async function pay() {
    if (state.phase !== 'ready') return;
    setState({ phase: 'paying', session: state.session });
    try {
      const res = await fetch(`/v1/checkout/sessions/${token}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentMethod }),
      });
      const body = await res.json();
      if (res.ok && body.status === 'success') {
        setState({ phase: 'success', successUrl: body.successUrl ?? null });
      } else {
        setState({ phase: 'failed', cancelUrl: body.cancelUrl ?? null });
      }
    } catch {
      setState({ phase: 'failed', cancelUrl: null });
    }
  }

  return (
    <div className="glass-card" style={{ width: 400, maxWidth: '90vw' }}>
      {state.phase === 'loading' && <p style={{ color: 'var(--text-secondary)' }}>Loading checkout…</p>}

      {state.phase === 'error' && (
        <>
          <h2 style={{ marginTop: 0 }}>Checkout unavailable</h2>
          <p style={{ color: 'var(--text-secondary)' }}>{state.message}</p>
        </>
      )}

      {(state.phase === 'ready' || state.phase === 'paying') && (
        <>
          <p style={{ color: 'var(--text-muted)', margin: '0 0 4px', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {state.session.applicationName}
          </p>
          <h1 style={{ margin: '0 0 24px', fontSize: 36 }}>{formatAmount(state.session.amount, state.session.currency)}</h1>

          <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--text-secondary)' }}>Payment method</label>
          <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} disabled={state.phase === 'paying'} style={{ marginBottom: 20 }}>
            <option value="card">Card</option>
            <option value="mobile_money">Mobile Money</option>
            <option value="bank_transfer">Bank Transfer</option>
          </select>

          <button className="btn-primary" onClick={pay} disabled={state.phase === 'paying'}>
            {state.phase === 'paying' ? 'Processing…' : `Pay ${formatAmount(state.session.amount, state.session.currency)}`}
          </button>
        </>
      )}

      {state.phase === 'success' && (
        <>
          <h2 style={{ marginTop: 0, color: 'var(--accent-green)' }}>Payment successful</h2>
          <p style={{ color: 'var(--text-secondary)' }}>Thank you — your payment has been processed.</p>
          {state.successUrl && (
            <button className="btn-primary" onClick={() => (window.location.href = state.successUrl!)}>
              Continue
            </button>
          )}
        </>
      )}

      {state.phase === 'failed' && (
        <>
          <h2 style={{ marginTop: 0, color: 'var(--accent-red)' }}>Payment failed</h2>
          <p style={{ color: 'var(--text-secondary)' }}>Something went wrong processing your payment. Please try again.</p>
          {state.cancelUrl && (
            <button className="btn-primary" onClick={() => (window.location.href = state.cancelUrl!)}>
              Back
            </button>
          )}
        </>
      )}
    </div>
  );
}

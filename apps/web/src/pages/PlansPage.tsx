import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import AppLayout from '../AppLayout';
import { useAuth, authFetch } from '../auth';
import { apiUrl } from '../api';

interface PlanRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  interval: string;
  messageLimit: number | null;
  paymentVolumeLimitCents: number | null;
}

interface SubscriptionRecord {
  id: string;
  planId: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
}

function formatPrice(cents: number, currency: string, interval: string): string {
  const amount = (cents / 100).toLocaleString(undefined, { style: 'currency', currency });
  return `${amount}/${interval}`;
}

export default function PlansPage() {
  const { token } = useAuth();
  const [plans, setPlans] = useState<PlanRecord[] | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionSlug, setActionSlug] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    const [plansRes, subRes] = await Promise.all([
      fetch(apiUrl('/v1/api/billing/plans')),
      authFetch(token, '/v1/api/billing/subscription'),
    ]);
    const plansBody = await plansRes.json();
    const subBody = await subRes.json();
    setPlans(plansBody.plans || []);
    setSubscription(subBody.subscription ?? null);
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSubscribe(slug: string) {
    if (!token) return;
    setError(null);
    setActionSlug(slug);
    try {
      const res = await authFetch(token, '/v1/api/billing/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planSlug: slug }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Subscription failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Subscription failed');
    } finally {
      setActionSlug(null);
    }
  }

  async function handleCancel() {
    if (!token) return;
    setError(null);
    setCanceling(true);
    try {
      const res = await authFetch(token, '/v1/api/billing/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ atPeriodEnd: true }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Cancellation failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancellation failed');
    } finally {
      setCanceling(false);
    }
  }

  const currentPlanId = subscription?.status === 'active' || subscription?.status === 'trialing' ? subscription.planId : null;

  return (
    <AppLayout>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '26px', fontWeight: 700, margin: '0 0 8px' }}>Plans & Billing</h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: '15px', margin: '0 0 28px' }}>
        Choose the plan that fits your usage. You can change or cancel at any time.
      </p>

      {error && (
        <div style={{ padding: '12px 16px', borderRadius: '10px', background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626', fontSize: '14px', marginBottom: '20px' }}>
          {error}
        </div>
      )}

      {subscription && subscription.status === 'active' && !subscription.cancelAtPeriodEnd && (
        <div style={{ marginBottom: '24px' }}>
          <button onClick={handleCancel} disabled={canceling} className="btn btn-secondary" style={{ fontSize: '14px', padding: '10px 16px' }}>
            {canceling ? 'Canceling…' : 'Cancel subscription'}
          </button>
        </div>
      )}
      {subscription?.cancelAtPeriodEnd && (
        <div style={{ padding: '12px 16px', borderRadius: '10px', background: 'var(--bg-subtle)', border: '1px solid var(--border)', fontSize: '14px', marginBottom: '24px' }}>
          Your subscription will end
          {subscription.currentPeriodEnd ? ` on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}` : ' at the end of the current period'}.
        </div>
      )}

      {plans === null ? (
        <Loader2 style={{ width: '22px', height: '22px', animation: 'spin 1s linear infinite', color: 'var(--text-muted)' }} />
      ) : (
        <div className="grid grid-3">
          {plans.map((plan) => {
            const isCurrent = plan.id === currentPlanId;
            return (
              <div key={plan.id} className="card" style={{ display: 'flex', flexDirection: 'column', borderColor: isCurrent ? 'var(--accent-2)' : undefined }}>
                {isCurrent && (
                  <span className="pill" style={{ alignSelf: 'flex-start', marginBottom: '14px', fontSize: '12px', padding: '5px 12px', color: 'var(--accent-2)', borderColor: 'var(--accent-2)' }}>
                    Current plan
                  </span>
                )}
                <h2 style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 6px' }}>{plan.name}</h2>
                <p style={{ fontFamily: 'var(--font-display)', fontSize: '26px', fontWeight: 700, margin: '0 0 10px' }}>
                  {formatPrice(plan.priceCents, plan.currency, plan.interval)}
                </p>
                {plan.description && (
                  <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6, margin: '0 0 16px' }}>{plan.description}</p>
                )}
                <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <Feature text={plan.messageLimit ? `${plan.messageLimit.toLocaleString()} messages / mo` : 'Unlimited messages'} />
                  <Feature
                    text={
                      plan.paymentVolumeLimitCents
                        ? `${(plan.paymentVolumeLimitCents / 100).toLocaleString(undefined, { style: 'currency', currency: plan.currency })} payment volume / mo`
                        : 'Unlimited payment volume'
                    }
                  />
                </ul>
                <button
                  onClick={() => handleSubscribe(plan.slug)}
                  disabled={isCurrent || actionSlug === plan.slug}
                  className={isCurrent ? 'btn btn-secondary' : 'btn btn-primary'}
                  style={{ marginTop: 'auto', width: '100%' }}
                >
                  {isCurrent ? 'Current plan' : actionSlug === plan.slug ? 'Subscribing…' : 'Subscribe'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </AppLayout>
  );
}

function Feature({ text }: { text: string }) {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', color: 'var(--text-secondary)' }}>
      <Check style={{ width: '15px', height: '15px', color: 'var(--accent)', flexShrink: 0 }} />
      {text}
    </li>
  );
}

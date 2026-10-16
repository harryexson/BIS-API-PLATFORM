import { useEffect, useState, type ReactNode } from 'react';
import { Building2, Mail, CreditCard, ArrowRight, Loader2 } from 'lucide-react';
import AppLayout from '../AppLayout';
import { useAuth, authFetch } from '../auth';

interface SubscriptionRecord {
  id: string;
  planId: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

interface PlanRecord {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  interval: string;
}

export default function DashboardPage() {
  const { token, user } = useAuth();
  const [subscription, setSubscription] = useState<SubscriptionRecord | null | undefined>(undefined);
  const [plan, setPlan] = useState<PlanRecord | null>(null);

  useEffect(() => {
    if (!token) return;
    authFetch(token, '/v1/api/billing/subscription')
      .then((res) => res.json())
      .then((body) => setSubscription(body.subscription ?? null))
      .catch(() => setSubscription(null));
  }, [token]);

  useEffect(() => {
    if (!token || !subscription) return;
    authFetch(token, '/v1/api/billing/plans')
      .then((res) => res.json())
      .then((body) => {
        const match = (body.plans || []).find((p: PlanRecord) => p.id === subscription.planId);
        setPlan(match ?? null);
      })
      .catch(() => undefined);
  }, [token, subscription]);

  if (!user) return null;

  return (
    <AppLayout>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '26px', fontWeight: 700, margin: '0 0 28px' }}>Dashboard</h1>

      <div className="grid grid-2" style={{ marginBottom: '28px' }}>
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
            <div className="icon-box" style={{ width: '40px', height: '40px', borderRadius: '10px' }}>
              <Building2 style={{ width: '18px', height: '18px' }} />
            </div>
            <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0 }}>Account</h2>
          </div>
          <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <Row icon={<Mail style={{ width: '14px', height: '14px' }} />} label="Email" value={user.email} />
            <Row label="Name" value={user.name || '—'} />
            <Row label="Email verified" value={user.emailVerifiedAt ? 'Yes' : 'Not yet verified'} />
          </dl>
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
            <div className="icon-box" style={{ width: '40px', height: '40px', borderRadius: '10px' }}>
              <CreditCard style={{ width: '18px', height: '18px' }} />
            </div>
            <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0 }}>Subscription</h2>
          </div>
          {subscription === undefined ? (
            <Loader2 style={{ width: '18px', height: '18px', animation: 'spin 1s linear infinite', color: 'var(--text-muted)' }} />
          ) : subscription === null ? (
            <>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', margin: '0 0 14px' }}>No active plan yet.</p>
              <a href="/plans" className="btn btn-primary" style={{ fontSize: '14px', padding: '11px 18px' }}>
                Choose a plan <ArrowRight style={{ width: '14px', height: '14px' }} />
              </a>
            </>
          ) : (
            <>
              <dl style={{ margin: '0 0 14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <Row label="Plan" value={plan ? plan.name : '…'} />
                <Row label="Status" value={subscription.status} />
                {subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd && (
                  <Row label="Ends" value={new Date(subscription.currentPeriodEnd).toLocaleDateString()} />
                )}
              </dl>
              <a href="/plans" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--accent-2)' }}>
                Manage plan →
              </a>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function Row({ icon, label, value }: { icon?: ReactNode; label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
      <dt style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)' }}>
        {icon}
        {label}
      </dt>
      <dd style={{ margin: 0, fontWeight: 600 }}>{value}</dd>
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import { CreditCard, Plus, PauseCircle, RefreshCw } from 'lucide-react';
import { SubscriptionPlan } from '../types';

interface SubscriptionManagementProps {
  token: string | null;
}

async function api(url: string, token: string | null, method = 'GET', body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-admin-token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? undefined : res.json();
}

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export const SubscriptionManagement: React.FC<SubscriptionManagementProps> = ({ token }) => {
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ slug: '', name: '', priceCents: '', currency: 'USD', billingInterval: 'month' });

  const [assignAppSlug, setAssignAppSlug] = useState('');
  const [assignTenantId, setAssignTenantId] = useState('default');
  const [assignPlanSlug, setAssignPlanSlug] = useState('');
  const [assignResult, setAssignResult] = useState<string | null>(null);

  const loadPlans = async () => {
    setError(null);
    try {
      const data = await api('/api/dashboard/plans', token);
      setPlans(data.plans || []);
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    loadPlans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createPlan = async () => {
    if (!form.slug.trim() || !form.name.trim() || !form.priceCents) return;
    setError(null);
    try {
      await api('/api/dashboard/plans', token, 'POST', {
        slug: form.slug.trim(),
        name: form.name.trim(),
        priceCents: Number(form.priceCents),
        currency: form.currency,
        billingInterval: form.billingInterval,
      });
      setForm({ slug: '', name: '', priceCents: '', currency: 'USD', billingInterval: 'month' });
      await loadPlans();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const deactivatePlan = async (id: string) => {
    setError(null);
    try {
      await api(`/api/dashboard/plans/${id}`, token, 'DELETE');
      await loadPlans();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const assignSubscription = async () => {
    if (!assignAppSlug.trim() || !assignPlanSlug.trim()) return;
    setError(null);
    setAssignResult(null);
    try {
      await api(
        `/api/dashboard/applications/${assignAppSlug.trim()}/tenants/${assignTenantId.trim() || 'default'}/subscription`,
        token,
        'POST',
        { planSlug: assignPlanSlug.trim() },
      );
      setAssignResult(`Subscribed ${assignAppSlug.trim()}/${assignTenantId.trim() || 'default'} to ${assignPlanSlug.trim()}.`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="two-col-grid">
      <div className="glass-card">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: 0 }}>
          <CreditCard className="w-5 h-5" style={{ color: 'var(--accent-cyan)' }} /> Pricing plans
          <button onClick={loadPlans} style={{ ...iconOnlyBtn, marginLeft: 'auto' }}>
            <RefreshCw className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
          </button>
        </h3>

        {error && <div style={errorStyle}>{error}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
          <input placeholder="slug (e.g. pro)" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} style={inputStyle} />
          <input placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          <input placeholder="price (cents)" value={form.priceCents} onChange={(e) => setForm({ ...form, priceCents: e.target.value })} style={inputStyle} />
          <input placeholder="currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} style={inputStyle} />
        </div>
        <button onClick={createPlan} style={{ ...btnStyle, marginBottom: '20px' }}><Plus className="w-4 h-4" /> Create plan</button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {plans.map((plan) => (
            <div key={plan.id} style={rowStyle}>
              <div>
                <div style={{ fontWeight: 600 }}>{plan.name} {!plan.isActive && <span style={{ color: 'var(--text-muted)' }}>(inactive)</span>}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {plan.slug} · {formatPrice(plan.priceCents, plan.currency)}/{plan.billingInterval}
                </div>
              </div>
              {plan.isActive && (
                <button onClick={() => deactivatePlan(plan.id)} style={iconOnlyBtn} title="Deactivate">
                  <PauseCircle className="w-4 h-4" style={{ color: 'var(--accent-yellow)' }} />
                </button>
              )}
            </div>
          ))}
          {plans.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No plans yet.</span>}
        </div>
      </div>

      <div className="glass-card">
        <h3 style={{ marginTop: 0 }}>Assign a tenant to a plan</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
          <input placeholder="application slug" value={assignAppSlug} onChange={(e) => setAssignAppSlug(e.target.value)} style={inputStyle} />
          <input placeholder="tenant id (default: 'default')" value={assignTenantId} onChange={(e) => setAssignTenantId(e.target.value)} style={inputStyle} />
          <select value={assignPlanSlug} onChange={(e) => setAssignPlanSlug(e.target.value)} style={inputStyle}>
            <option value="">Select a plan…</option>
            {plans.filter((p) => p.isActive).map((p) => (
              <option key={p.id} value={p.slug}>{p.name} ({formatPrice(p.priceCents, p.currency)}/{p.billingInterval})</option>
            ))}
          </select>
        </div>
        <button onClick={assignSubscription} style={btnStyle}>Assign subscription</button>
        {assignResult && <div style={{ marginTop: '12px', color: 'var(--accent-green)', fontSize: '13px' }}>{assignResult}</div>}
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '20px' }}>
          This is the platform's own record of billing status. It does not call Stripe —
          connect a Stripe account to sync stripeCustomerId/stripeSubscriptionId once ready.
        </p>
      </div>
    </div>
  );
};

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--glass-border)',
  borderRadius: '8px',
  padding: '8px 12px',
  color: 'var(--text-primary)',
  fontSize: '13px',
};

const btnStyle: React.CSSProperties = {
  background: 'rgba(6,182,212,0.12)',
  border: '1px solid var(--accent-cyan)',
  color: 'var(--accent-cyan)',
  borderRadius: '8px',
  padding: '8px 14px',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  justifyContent: 'center',
};

const iconOnlyBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--glass-border)',
  borderRadius: '8px',
  padding: '10px 12px',
  fontSize: '13px',
};

const errorStyle: React.CSSProperties = {
  background: 'rgba(239,68,68,0.1)',
  border: '1px solid var(--accent-red)',
  color: 'var(--accent-red)',
  borderRadius: '8px',
  padding: '8px 12px',
  fontSize: '13px',
  marginBottom: '16px',
};

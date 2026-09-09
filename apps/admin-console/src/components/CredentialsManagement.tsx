import React, { useState } from 'react';
import { QrCode, Plus, Ban, RefreshCw } from 'lucide-react';
import { AccessCredential } from '../types';

interface CredentialsManagementProps {
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

const STATUS_COLOR: Record<string, string> = {
  active: 'var(--accent-green)',
  revoked: 'var(--accent-red)',
  expired: 'var(--text-muted)',
};

const PURPOSE_LABEL: Record<string, string> = {
  check_in: 'Event check-in',
  asset_tracking: 'Asset / shipment tracking',
  membership: 'Membership / loyalty',
};

export const CredentialsManagement: React.FC<CredentialsManagementProps> = ({ token }) => {
  const [appId, setAppId] = useState('');
  const [tenantId, setTenantId] = useState('default');
  const [credentials, setCredentials] = useState<AccessCredential[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({ purpose: 'check_in', ownerType: 'attendee', ownerRef: '', label: '', credentialType: 'qr' });

  const load = async () => {
    if (!appId.trim()) return;
    setError(null);
    try {
      const data = await api(
        `/api/dashboard/applications/${appId.trim()}/tenants/${tenantId.trim() || 'default'}/credentials`,
        token,
      );
      setCredentials(data.credentials || []);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const issue = async () => {
    if (!appId.trim() || !form.ownerRef.trim()) return;
    setError(null);
    try {
      await api(
        `/api/dashboard/applications/${appId.trim()}/tenants/${tenantId.trim() || 'default'}/credentials`,
        token,
        'POST',
        form,
      );
      setForm({ ...form, ownerRef: '', label: '' });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await api(`/api/dashboard/credentials/${id}/revoke?appId=${encodeURIComponent(appId.trim())}`, token, 'POST');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="two-col-grid">
      <div className="glass-card">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: 0 }}>
          <QrCode className="w-5 h-5" style={{ color: 'var(--accent-cyan)' }} /> Credentials (NFC / QR)
          <button onClick={load} style={{ ...iconOnlyBtn, marginLeft: 'auto' }}>
            <RefreshCw className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
          </button>
        </h3>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          <input placeholder="application slug" value={appId} onChange={(e) => setAppId(e.target.value)} style={inputStyle} />
          <input placeholder="tenant id" value={tenantId} onChange={(e) => setTenantId(e.target.value)} style={{ ...inputStyle, maxWidth: '120px' }} />
        </div>

        {error && <div style={errorStyle}>{error}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {credentials.map((c) => (
            <div key={c.id} style={rowStyle}>
              <div>
                <div style={{ fontWeight: 600 }}>{c.label || c.ownerRef}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {PURPOSE_LABEL[c.purpose] || c.purpose} · {c.credentialType.toUpperCase()} · {c.ownerType}:{c.ownerRef}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ color: STATUS_COLOR[c.status] || 'var(--text-muted)', fontSize: '12px', fontWeight: 700, textTransform: 'uppercase' }}>
                  {c.status}
                </span>
                {c.status === 'active' && (
                  <button onClick={() => revoke(c.id)} style={iconOnlyBtn} title="Revoke">
                    <Ban className="w-4 h-4" style={{ color: 'var(--accent-red)' }} />
                  </button>
                )}
              </div>
            </div>
          ))}
          {credentials.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No credentials loaded.</span>}
        </div>
      </div>

      <div className="glass-card">
        <h3 style={{ marginTop: 0 }}>Issue a credential</h3>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          One generic model backs event check-in, asset/shipment tracking, and
          membership/loyalty — they all reduce to "issue a token bound to an
          owner, then verify a scan of it." The mobile app calls the same
          issue/verify endpoints directly for self-service issuance.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <select value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} style={inputStyle}>
            <option value="check_in">Event check-in</option>
            <option value="asset_tracking">Asset / shipment tracking</option>
            <option value="membership">Membership / loyalty</option>
          </select>
          <select value={form.credentialType} onChange={(e) => setForm({ ...form, credentialType: e.target.value })} style={inputStyle}>
            <option value="qr">QR code</option>
            <option value="nfc">NFC tag</option>
          </select>
          <input placeholder="owner type (e.g. attendee, asset, member)" value={form.ownerType} onChange={(e) => setForm({ ...form, ownerType: e.target.value })} style={inputStyle} />
          <input placeholder="owner ref (e.g. member id, asset id)" value={form.ownerRef} onChange={(e) => setForm({ ...form, ownerRef: e.target.value })} style={inputStyle} />
          <input placeholder="label (optional)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} style={inputStyle} />
        </div>
        <button onClick={issue} style={{ ...btnStyle, marginTop: '12px' }}><Plus className="w-4 h-4" /> Issue credential</button>
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

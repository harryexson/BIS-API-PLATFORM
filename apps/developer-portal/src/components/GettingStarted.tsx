import { useEffect, useState } from 'react';
import { portalFetch } from '../auth';

interface Props {
  token: string;
  appSlug: string;
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
}

export default function GettingStarted({ token, appSlug }: Props) {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);

  useEffect(() => {
    portalFetch(token, '/v1/portal/tenants')
      .then((res) => res.json())
      .then((body) => setTenants(body.tenants || []))
      .catch(() => setTenants([]));
  }, [token]);

  const tenantId = tenants?.[0]?.id ?? 'YOUR_TENANT_ID';

  const snippet = `curl -X POST https://api.your-domain.com/v1/api/gateway/payment \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "x-tenant-id: ${tenantId}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{
    "appId": "${appSlug}",
    "amount": 25,
    "currency": "USD",
    "paymentMethod": "card"
  }'`;

  return (
    <div>
      <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>Getting started</h2>
      <div className="glass-card" style={{ marginBottom: 16 }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 0 }}>
          Grab an API key from the <strong>API Keys</strong> tab, then create your first payment. Your account
          ships with one default tenant ready to use — its ID is already filled in below.
        </p>
        <pre style={{ background: '#111113', color: '#e4e4e7', padding: 16, borderRadius: 8, overflowX: 'auto', fontSize: 13, lineHeight: 1.7, fontFamily: 'var(--font-mono)' }}>
          {snippet}
        </pre>
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Always send a unique <code>Idempotency-Key</code> on payment/refund requests — replaying the same key
          returns the original result instead of double-charging.
        </p>
      </div>
      <div className="glass-card">
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 0, marginBottom: 0 }}>
          Full API reference: see <code>docs/openapi.yaml</code> and <code>docs/DEVELOPER_GUIDE.md</code> in the
          platform repository for every endpoint, webhook payload, and error code.
        </p>
      </div>
    </div>
  );
}

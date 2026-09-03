interface Props {
  appSlug: string;
}

export default function GettingStarted({ appSlug }: Props) {
  const snippet = `curl -X POST https://api.your-domain.com/v1/api/gateway/payment \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "x-tenant-id: YOUR_TENANT_ID" \\
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
          Grab an API key from the <strong>API Keys</strong> tab, then create your first payment:
        </p>
        <pre style={{ background: 'var(--bg-secondary)', padding: 16, borderRadius: 8, overflowX: 'auto', fontSize: 13, fontFamily: 'var(--font-mono)' }}>
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

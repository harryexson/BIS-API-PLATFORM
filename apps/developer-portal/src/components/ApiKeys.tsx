import { useCallback, useEffect, useState } from 'react';
import { portalFetch } from '../auth';

interface ApiKey {
  id: string;
  prefix: string;
  environment: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export default function ApiKeys({ token }: { token: string }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [newKey, setNewKey] = useState<{ prefix: string; raw: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await portalFetch(token, '/v1/portal/api-keys');
    const body = await res.json();
    setKeys(body.apiKeys || []);
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function createKey() {
    setBusy(true);
    const res = await portalFetch(token, '/v1/portal/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await res.json();
    setBusy(false);
    if (res.ok) {
      setNewKey({ prefix: body.prefix, raw: body.raw });
      load();
    }
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this API key? Anything using it will stop working immediately.')) return;
    await portalFetch(token, `/v1/portal/api-keys/${id}`, { method: 'DELETE' });
    load();
  }

  return (
    <div>
      {newKey && (
        <div className="glass-card" style={{ marginBottom: 20, borderColor: 'var(--accent-cyan)' }}>
          <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-secondary)' }}>
            New key created — copy it now, it won't be shown again:
          </p>
          <div style={{ background: 'var(--bg-secondary)', padding: 12, borderRadius: 8, fontFamily: 'var(--font-mono)', fontSize: 13, wordBreak: 'break-all' }}>
            {newKey.raw}
          </div>
          <button className="btn-secondary" style={{ marginTop: 12 }} onClick={() => setNewKey(null)}>Dismiss</button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>API Keys</h2>
        <button className="btn-primary" onClick={createKey} disabled={busy}>{busy ? 'Creating…' : '+ New key'}</button>
      </div>

      <div className="glass-card">
        {keys === null ? (
          <p style={{ color: 'var(--text-secondary)' }}>Loading…</p>
        ) : keys.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)' }}>No API keys yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Prefix</th><th>Environment</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.prefix}…</td>
                  <td>{k.environment}</td>
                  <td>{new Date(k.createdAt).toLocaleDateString()}</td>
                  <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'Never'}</td>
                  <td>{k.revokedAt ? <span style={{ color: 'var(--accent-red)' }}>Revoked</span> : <span style={{ color: 'var(--accent-green)' }}>Active</span>}</td>
                  <td>{!k.revokedAt && <button className="btn-danger" onClick={() => revoke(k.id)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

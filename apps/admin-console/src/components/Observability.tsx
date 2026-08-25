import React, { useEffect, useState } from 'react';
import { Activity, Gauge, ListTree, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useAuth } from '../auth';

interface MetricsSnapshot {
  counters: Record<string, number>;
  latency: {
    count: number;
    sum: number;
    avg: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
  };
  providerHealth: Record<string, string>;
}

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  requestId?: string;
  correlationId?: string;
  applicationId?: string;
  tenantId?: string;
  supplierId?: string;
  providerId?: string;
  operation?: string;
  status?: number | string;
  latency?: number;
  errorCode?: string;
}

const COUNTER_META: { key: string; label: string; color: string }[] = [
  { key: 'apiErrors', label: 'API Errors', color: 'var(--accent-red)' },
  { key: 'paymentSuccess', label: 'Payment Success', color: 'var(--accent-green)' },
  { key: 'paymentFailure', label: 'Payment Failure', color: 'var(--accent-red)' },
  { key: 'messageSuccess', label: 'Message Success', color: 'var(--accent-green)' },
  { key: 'messageFailure', label: 'Message Failure', color: 'var(--accent-red)' },
  { key: 'providerHealth', label: 'Provider Health', color: 'var(--accent-cyan)' },
  { key: 'webhookFailures', label: 'Webhook Failures', color: 'var(--accent-yellow)' },
  { key: 'queueFailures', label: 'Queue Failures', color: 'var(--accent-yellow)' },
  { key: 'routingFailures', label: 'Routing Failures', color: 'var(--accent-yellow)' },
];

const HEALTH_COLOR: Record<string, string> = {
  healthy: 'var(--accent-green)',
  degraded: 'var(--accent-yellow)',
  down: 'var(--accent-red)',
  unknown: 'var(--text-muted)',
};

export const Observability: React.FC = () => {
  const { isAdmin, token } = useAuth();
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchAll = async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const headers = { 'x-admin-token': token || '' };
      const [mRes, lRes] = await Promise.all([
        fetch('/api/observability/metrics', { headers }),
        fetch('/api/observability/logs', { headers }),
      ]);
      if (mRes.ok) setMetrics(await mRes.json());
      if (lRes.ok) setLogs(await lRes.json());
    } catch (err) {
      console.error('Failed to fetch observability data', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    if (!isAdmin) return;
    const id = setInterval(fetchAll, 5000);
    return () => clearInterval(id);
  }, [isAdmin, token]);

  if (!isAdmin) {
    return (
      <div className="glass-card" style={{ padding: '24px', textAlign: 'center' }}>
        <ShieldCheck className="w-8 h-8" style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
        <h3 style={{ margin: 0, fontWeight: 700 }}>Observability</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
          Administrator login is required to view metrics and structured logs.
        </p>
      </div>
    );
  }

  const counters = metrics?.counters || {};
  const latency = metrics?.latency;

  return (
    <div className="glass-card" style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Activity className="w-5 h-5" style={{ color: 'var(--accent-cyan)' }} />
          Observability
        </h3>
        <button onClick={fetchAll} disabled={loading} style={actionBtn('var(--text-secondary)')}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Metric counters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
        {COUNTER_META.map((c) => (
          <div key={c.key} style={counterCardStyle(c.color)}>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{c.label}</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: c.color }}>{counters[c.key] ?? 0}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
        {/* Latency */}
        <div className="glass-card" style={{ padding: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--accent-cyan)', fontWeight: 600, fontSize: '13px', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            <Gauge className="w-4 h-4" /> API Latency (ms)
          </div>
          {latency ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <LatencyStat label="Avg" value={latency.avg} />
              <LatencyStat label="p50" value={latency.p50} />
              <LatencyStat label="p95" value={latency.p95} />
              <LatencyStat label="p99" value={latency.p99} />
              <LatencyStat label="Samples" value={latency.count} />
              <LatencyStat label="Max" value={latency.max} />
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>No data yet</div>
          )}
        </div>

        {/* Provider health */}
        <div className="glass-card" style={{ padding: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--accent-cyan)', fontWeight: 600, fontSize: '13px', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            <Activity className="w-4 h-4" /> Provider Health
          </div>
          {metrics && Object.keys(metrics.providerHealth).length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {Object.entries(metrics.providerHealth).map(([provider, status]) => (
                <div key={provider} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span style={{ color: 'var(--text-primary)' }}>{provider}</span>
                  <span style={{ color: HEALTH_COLOR[status] || 'var(--text-muted)', fontWeight: 600, textTransform: 'capitalize' }}>
                    {status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>No health data yet — run a health check</div>
          )}
        </div>
      </div>

      {/* Structured logs */}
      <div className="glass-card" style={{ padding: '16px', marginTop: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--accent-cyan)', fontWeight: 600, fontSize: '13px', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          <ListTree className="w-4 h-4" /> Structured Logs (redacted)
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', minWidth: '900px' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', borderBottom: '1px solid var(--glass-border)' }}>
                <Th>Time</Th>
                <Th>Level</Th>
                <Th>Operation</Th>
                <Th>Provider</Th>
                <Th>App</Th>
                <Th>Status</Th>
                <Th>Latency</Th>
                <Th>Error</Th>
                <Th>Message</Th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr><Td colSpan={8}><span style={{ color: 'var(--text-muted)' }}>No logs captured yet</span></Td></tr>
              ) : (
                logs.slice(0, 100).map((l, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <Td>{new Date(l.timestamp).toLocaleTimeString()}</Td>
                    <Td>
                      <span style={{ color: l.level === 'error' ? 'var(--accent-red)' : l.level === 'warn' ? 'var(--accent-yellow)' : 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase' }}>
                        {l.level}
                      </span>
                    </Td>
                    <Td>{l.operation || '—'}</Td>
                    <Td>{l.providerId || '—'}</Td>
                    <Td>{l.applicationId || '—'}</Td>
                    <Td>
                      {l.status !== undefined ? (
                        <span style={{ color: typeof l.status === 'number' && l.status >= 500 ? 'var(--accent-red)' : 'var(--accent-green)' }}>{String(l.status)}</span>
                      ) : '—'}
                    </Td>
                    <Td>{l.latency !== undefined ? `${l.latency}ms` : '—'}</Td>
                    <Td>{l.errorCode ? <span style={{ color: 'var(--accent-red)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}><AlertTriangle className="w-3 h-3" />{l.errorCode}</span> : '—'}</Td>
                    <Td style={{ maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.message}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

function LatencyStat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '8px', padding: '8px 10px' }}>
      <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontSize: '15px', fontWeight: 700 }}>{typeof value === 'number' ? Math.round(value) : value}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: '6px 8px', fontWeight: 600, whiteSpace: 'nowrap' }}>{children}</th>;
}
function Td({ children, style, colSpan }: { children?: React.ReactNode; style?: React.CSSProperties; colSpan?: number }) {
  return <td colSpan={colSpan} style={{ padding: '6px 8px', verticalAlign: 'top', ...style }}>{children}</td>;
}

function counterCardStyle(color: string): React.CSSProperties {
  return {
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid rgba(255,255,255,0.04)',
    borderRadius: '8px',
    padding: '10px 14px',
    minWidth: '130px',
  };
}

function actionBtn(color: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    background: 'var(--bg-tertiary)',
    border: `1px solid ${color}`,
    color: 'var(--text-primary)',
    padding: '6px 12px',
    borderRadius: '8px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
  };
}

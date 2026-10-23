import React, { useEffect, useState } from 'react';
import { Network, Globe, RefreshCw, Cpu, Layers, Server, ShieldCheck, LogOut, Activity, Users } from 'lucide-react';
import { MetricCards } from './components/MetricCards';
import { LiveTopology } from './components/LiveTopology';
import { ProviderRegistry } from './components/ProviderRegistry';
import { RequestPlayground } from './components/RequestPlayground';
import { AuditLogs } from './components/AuditLogs';
import { ProviderManagement } from './components/ProviderManagement';
import { Observability } from './components/Observability';
import { Customers } from './components/Customers';
import { LoginGate } from './components/LoginGate';
import { useAuth } from './auth';
import { ProviderConfig, ProviderManagement as ProviderManagementType, TransactionEvent, DashboardMetrics } from './types';

const INITIAL_METRICS: DashboardMetrics = {
  totalRequests: 0,
  successRate: 100,
  averageLatency: 0,
  totalCost: 0,
  volumePerProvider: {},
  volumePerApp: {}
};

type Tab = 'operations' | 'management' | 'observability' | 'customers';

export const App: React.FC = () => {
  const { token, isAdmin, logout } = useAuth();
  const [tab, setTab] = useState<Tab>('operations');
  const [showLogin, setShowLogin] = useState(false);

  const [providers, setProviders] = useState<ProviderManagementType[]>([]);
  const [logs, setLogs] = useState<TransactionEvent[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics>(INITIAL_METRICS);
  const [lastEvent, setLastEvent] = useState<TransactionEvent | null>(null);

  const [playgroundLoading, setPlaygroundLoading] = useState(false);
  const [playgroundResponse, setPlaygroundResponse] = useState<any>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Phase 20-21 (gap register C7): /api/dashboard/providers is admin-only
  // now (it used to be public and exposed every provider's fees, routing
  // rules and error rates to anyone).
  const fetchProviders = async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch('/api/dashboard/providers', { headers: { 'x-admin-token': token || '' } });
      const data = await res.json();
      if (res.ok && Array.isArray(data)) setProviders(data);
    } catch (err) {
      console.error('Failed to fetch provider registry configs:', err);
    }
  };

  // /api/dashboard/logs and /metrics require admin auth — without a token
  // these 403 with an error object, not an array/metrics shape, which used
  // to crash AuditLogs's logs.map() and take down the whole app with no
  // error boundary. Gate on isAdmin and attach the token like every other
  // admin-console component already does (see Observability.tsx).
  const fetchLogs = async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch('/api/dashboard/logs', { headers: { 'x-admin-token': token || '' } });
      const data = await res.json();
      if (res.ok && Array.isArray(data)) setLogs(data);
    } catch (err) {
      console.error('Failed to fetch transaction logs:', err);
    }
  };

  const fetchMetrics = async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch('/api/dashboard/metrics', { headers: { 'x-admin-token': token || '' } });
      const data = await res.json();
      if (res.ok) setMetrics(data);
    } catch (err) {
      console.error('Failed to fetch metrics:', err);
    }
  };

  const handleRefreshAll = async () => {
    setRefreshing(true);
    await Promise.all([fetchProviders(), fetchLogs(), fetchMetrics()]);
    setRefreshing(false);
  };

  // Updates provider configurations (Online status, weight, latency) on the gateway
  const handleUpdateProvider = async (id: string, updates: Partial<ProviderConfig>) => {
    try {
      const res = await fetch(`/api/dashboard/providers/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'x-admin-token': token } : {}),
        },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        const updated = await res.json();
        setProviders(prev => prev.map(p => p.id === id ? updated : p));
      }
    } catch (err) {
      console.error('Failed to update provider status:', err);
    }
  };

  // Triggers request dispatch from the dashboard client to mock real app traffic.
  // The gateway requires a real application API key + tenant ID (mw.apiKey +
  // resolveTenantContext) — get both from the Developer Portal's API Keys tab.
  const handleDispatchRequest = async (
    category: 'payment' | 'messaging' | 'other',
    payload: any,
    auth: { apiKey: string; tenantId: string },
  ) => {
    setPlaygroundLoading(true);
    setPlaygroundResponse(null);

    const endpoint = `/v1/api/gateway/${category}`;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.apiKey}`,
          'x-tenant-id': auth.tenantId,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      setPlaygroundResponse(data);
    } catch (err: any) {
      console.error('API Gateway Request Error:', err);
      setPlaygroundResponse({ error: err.message || 'Gateway Timeout / Connection Refused' });
    } finally {
      setPlaygroundLoading(false);
    }
  };

  // Clears active logs
  const handleClearLogs = async () => {
    try {
      const res = await fetch('/api/dashboard/logs/clear', {
        method: 'POST',
        headers: { 'x-admin-token': token || '' },
      });
      if (res.ok) {
        setLogs([]);
        setMetrics(INITIAL_METRICS);
        setLastEvent(null);
        setPlaygroundResponse(null);
      }
    } catch (err) {
      console.error('Failed to clear gateway logs:', err);
    }
  };

  // Establish the live event stream.
  //
  // Phase 20-21 (gap register C7): the gateway accepts the admin token ONLY
  // in the x-admin-token header — never in the URL (it used to travel as
  // ?token=..., i.e. into proxy/access logs and browser history, because the
  // EventSource API cannot set headers). The stream is therefore read with
  // fetch() + a ReadableStream, which can send the header, and parsed as
  // server-sent events by hand. Reconnects with a short backoff.
  useEffect(() => {
    fetchProviders();
    fetchLogs();
    fetchMetrics();

    if (!isAdmin) return;
    const controller = new AbortController();
    let metricsTimer: ReturnType<typeof setTimeout> | null = null;
    // One /metrics refresh per burst of events, not one admin request (and
    // one admin audit row) per event.
    const scheduleMetrics = () => {
      if (metricsTimer) return;
      metricsTimer = setTimeout(() => {
        metricsTimer = null;
        fetchMetrics();
      }, 2000);
    };

    const handleData = (raw: string) => {
      const data = JSON.parse(raw);
      if (data.type === 'connected') return;
      const newEvent = data as TransactionEvent;
      if (newEvent.appId === 'system-dashboard') {
        fetchProviders();
        return;
      }
      setLogs((prev) => [newEvent, ...prev.slice(0, 99)]);
      setLastEvent(newEvent);
      scheduleMetrics();
    };

    const connect = async () => {
      while (!controller.signal.aborted) {
        try {
          const res = await fetch('/api/dashboard/stream', {
            headers: { 'x-admin-token': token || '', Accept: 'text/event-stream' },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream refused: ${res.status}`);
          setSseConnected(true);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep: number;
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              const payload = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (payload) {
                try {
                  handleData(payload);
                } catch (err) {
                  console.error('Malformed stream event:', err);
                }
              }
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          console.error('Live stream disconnected:', err);
        }
        setSseConnected(false);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    };
    connect();

    return () => {
      controller.abort();
      if (metricsTimer) clearTimeout(metricsTimer);
      setSseConnected(false);
    };
  }, [isAdmin, token]);

  return (
    <div className="main-layout">
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '32px',
          borderBottom: '1px solid rgba(16, 16, 18, 0.05)',
          paddingBottom: '20px',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '8px',
              background: 'var(--accent-cyan)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Network className="w-6 h-6 text-white" style={{ color: '#ffffff' }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: '20px', fontWeight: 600, letterSpacing: '-0.01em' }}>
              BIS API Gateway Platform
            </h1>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              Orchestration & Dynamic Routing Engine Dashboard
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: 'rgba(16, 16, 18, 0.02)',
              border: '1px solid rgba(16, 16, 18, 0.05)',
              padding: '6px 12px',
              borderRadius: '20px',
              fontSize: '12px',
            }}
          >
            <Globe className={`w-4 h-4 ${sseConnected ? 'text-emerald-400 animate-pulse' : 'text-rose-500'}`} style={{ color: sseConnected ? 'var(--accent-green)' : 'var(--accent-red)' }} />
            <span>SSE Stream: </span>
            <span style={{ fontWeight: 700, color: sseConnected ? 'var(--accent-green)' : 'var(--accent-red)' }}>
              {sseConnected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
          </div>

          <button
            onClick={handleRefreshAll}
            disabled={refreshing}
            style={iconBtn}
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>

          {isAdmin ? (
            <button onClick={logout} style={adminPill(false)} title="Log out administrator">
              <ShieldCheck className="w-4 h-4" /> Admin <LogOut className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button onClick={() => setShowLogin(true)} style={adminPill(true)} title="Administrator login">
              <ShieldCheck className="w-4 h-4" /> Admin Login
            </button>
          )}
        </div>
      </header>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
        <TabButton active={tab === 'operations'} onClick={() => setTab('operations')} icon={<Cpu className="w-4 h-4" />} label="Operations Dashboard" />
        <TabButton active={tab === 'management'} onClick={() => setTab('management')} icon={<Server className="w-4 h-4" />} label="Provider Management" />
        <TabButton active={tab === 'observability'} onClick={() => setTab('observability')} icon={<Activity className="w-4 h-4" />} label="Observability" />
        <TabButton active={tab === 'customers'} onClick={() => setTab('customers')} icon={<Users className="w-4 h-4" />} label="Customers" />
      </div>

      {tab === 'operations' && (
        <>
          <MetricCards metrics={metrics} />

          <div style={{ marginBottom: '24px' }}>
            <LiveTopology providers={providers} lastEvent={lastEvent} />
          </div>

          <div className="two-col-grid">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              <RequestPlayground
                providers={providers}
                onRequestSent={handleDispatchRequest}
                lastEvent={playgroundResponse}
                loading={playgroundLoading}
              />
              <AuditLogs logs={logs} onClearLogs={handleClearLogs} />
            </div>

            <div>
              <ProviderRegistry
                providers={providers}
                onUpdateProvider={handleUpdateProvider}
              />
            </div>
          </div>
        </>
      )}

      {tab === 'management' && (
        <ProviderManagement
          providers={providers}
          isAdmin={isAdmin}
          token={token}
          onRefresh={fetchProviders}
        />
      )}

      {tab === 'observability' && <Observability />}

      {tab === 'customers' && <Customers isAdmin={isAdmin} token={token} />}

      {showLogin && <LoginGate onClose={() => setShowLogin(false)} />}
    </div>
  );
};

const iconBtn: React.CSSProperties = {
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--glass-border)',
  color: 'var(--text-primary)',
  width: '36px',
  height: '36px',
  borderRadius: '8px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

function adminPill(needsLogin: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    background: needsLogin ? 'rgba(16, 16, 18, 0.04)' : 'rgba(22, 163, 74, 0.1)',
    border: `1px solid ${needsLogin ? 'var(--glass-border)' : 'var(--accent-green)'}`,
    color: needsLogin ? 'var(--text-primary)' : 'var(--accent-green)',
    padding: '6px 12px',
    borderRadius: '20px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
  };
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 18px',
        borderRadius: '10px',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
        border: active ? '1px solid var(--accent-cyan)' : '1px solid var(--glass-border)',
        background: active ? 'rgba(255, 90, 31, 0.1)' : 'var(--bg-tertiary)',
        color: active ? 'var(--accent-cyan)' : 'var(--text-secondary)',
      }}
    >
      {icon} {label}
    </button>
  );
}

export default App;

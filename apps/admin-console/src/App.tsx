import React, { useEffect, useState } from 'react';
import { Network, Globe, RefreshCw, Cpu, Layers } from 'lucide-react';
import { MetricCards } from './components/MetricCards';
import { LiveTopology } from './components/LiveTopology';
import { ProviderRegistry } from './components/ProviderRegistry';
import { RequestPlayground } from './components/RequestPlayground';
import { AuditLogs } from './components/AuditLogs';
import { ProviderConfig, TransactionEvent, DashboardMetrics } from './types';

const INITIAL_METRICS: DashboardMetrics = {
  totalRequests: 0,
  successRate: 100,
  averageLatency: 0,
  totalCost: 0,
  volumePerProvider: {},
  volumePerApp: {}
};

export const App: React.FC = () => {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [logs, setLogs] = useState<TransactionEvent[]>([]);
  const [metrics, setMetrics] = useState<DashboardMetrics>(INITIAL_METRICS);
  const [lastEvent, setLastEvent] = useState<TransactionEvent | null>(null);
  
  const [playgroundLoading, setPlaygroundLoading] = useState(false);
  const [playgroundResponse, setPlaygroundResponse] = useState<any>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchProviders = async () => {
    try {
      const res = await fetch('/api/dashboard/providers');
      const data = await res.json();
      setProviders(data);
    } catch (err) {
      console.error('Failed to fetch provider registry configs:', err);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/dashboard/logs');
      const data = await res.json();
      setLogs(data);
    } catch (err) {
      console.error('Failed to fetch transaction logs:', err);
    }
  };

  const fetchMetrics = async () => {
    try {
      const res = await fetch('/api/dashboard/metrics');
      const data = await res.json();
      setMetrics(data);
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (res.ok) {
        const updated = await res.json();
        // Update local providers state instantly for smooth interaction
        setProviders(prev => prev.map(p => p.id === id ? updated : p));
      }
    } catch (err) {
      console.error('Failed to update provider status:', err);
    }
  };

  // Triggers request dispatch from the dashboard client to mock real app traffic
  const handleDispatchRequest = async (category: 'payment' | 'messaging' | 'other', payload: any) => {
    setPlaygroundLoading(true);
    setPlaygroundResponse(null);

    const endpoint = `/api/gateway/${category === 'payment' ? 'payment' : category === 'messaging' ? 'messaging' : 'other'}`;
    
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
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
      const res = await fetch('/api/dashboard/logs/clear', { method: 'POST' });
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

  // Establish SSE Connection
  useEffect(() => {
    // Initial fetches
    fetchProviders();
    fetchLogs();
    fetchMetrics();

    const eventSource = new EventSource('/api/dashboard/stream');

    eventSource.onopen = () => {
      setSseConnected(true);
    };

    eventSource.onerror = () => {
      setSseConnected(false);
    };

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      // Ignore initial handshake message
      if (data.type === 'connected') return;

      const newEvent = data as TransactionEvent;

      // Handle config update messages vs actual traffic
      if (newEvent.appId === 'system-dashboard') {
        // Just refresh the provider list to make sure we are sync'd
        fetchProviders();
        return;
      }

      // Add to logs and trigger metric updates
      setLogs((prev) => [newEvent, ...prev.slice(0, 99)]);
      setLastEvent(newEvent);
      fetchMetrics();
    };

    return () => {
      eventSource.close();
    };
  }, []);

  return (
    <div className="main-layout">
      {/* Top Header Section */}
      <header 
        style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          marginBottom: '32px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
          paddingBottom: '20px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '44px',
            height: '44px',
            borderRadius: '12px',
            background: 'linear-gradient(135deg, var(--accent-cyan) 0%, var(--accent-purple) 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 20px rgba(6, 182, 212, 0.3)'
          }}>
            <Network className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '22px', fontWeight: '800', letterSpacing: '-0.5px' }}>
              BIS API GATEWAY PLATFORM
            </h1>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              Orchestration & Dynamic Routing Engine Dashboard
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* Connection state */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid rgba(255, 255, 255, 0.05)',
            padding: '6px 12px',
            borderRadius: '20px',
            fontSize: '12px'
          }}>
            <Globe className={`w-4 h-4 ${sseConnected ? 'text-emerald-400 animate-pulse' : 'text-rose-500'}`} style={{ color: sseConnected ? 'var(--accent-green)' : 'var(--accent-red)' }} />
            <span>SSE Stream: </span>
            <span style={{ fontWeight: '700', color: sseConnected ? 'var(--accent-green)' : 'var(--accent-red)' }}>
              {sseConnected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
          </div>

          {/* Refresh button */}
          <button
            onClick={handleRefreshAll}
            disabled={refreshing}
            style={{
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
              transition: 'background 0.2s'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* Metrics Section */}
      <MetricCards metrics={metrics} />

      {/* Topology Canvas Flow Graph */}
      <div style={{ marginBottom: '24px' }}>
        <LiveTopology providers={providers} lastEvent={lastEvent} />
      </div>

      {/* Main interactive grid columns */}
      <div className="two-col-grid">
        {/* Left Side: Playground & Logs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <RequestPlayground
            providers={providers}
            onRequestSent={handleDispatchRequest}
            lastEvent={playgroundResponse}
            loading={playgroundLoading}
          />
          
          <AuditLogs logs={logs} onClearLogs={handleClearLogs} />
        </div>

        {/* Right Side: Registry Manager */}
        <div>
          <ProviderRegistry
            providers={providers}
            onUpdateProvider={handleUpdateProvider}
          />
        </div>
      </div>
    </div>
  );
};

export default App;

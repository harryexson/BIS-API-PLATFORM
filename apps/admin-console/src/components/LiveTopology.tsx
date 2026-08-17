import React, { useEffect, useState } from 'react';
import { Smartphone, ShieldAlert, Cpu, ArrowDown, ExternalLink } from 'lucide-react';
import { ProviderConfig, TransactionEvent } from '../types';

interface LiveTopologyProps {
  providers: ProviderConfig[];
  lastEvent: TransactionEvent | null;
}

export const LiveTopology: React.FC<LiveTopologyProps> = ({ providers, lastEvent }) => {
  const [activeFlow, setActiveFlow] = useState<{
    id: string;
    appX: number;
    routerX: number;
    providerX: number;
    status: 'success' | 'failed';
  } | null>(null);

  // App coordinates (X values out of 1000)
  const appMap: Record<string, { name: string, x: number }> = {
    reachchurch: { name: 'ReachChurch', x: 60 },
    afribook: { name: 'Afribook', x: 180 },
    haulpro: { name: 'HaulPro', x: 300 },
    stayscape: { name: 'STAYSCAPE', x: 420 },
    eventhub: { name: 'EventHub', x: 580 },
    ridely: { name: 'Ride-ly', x: 700 },
    food: { name: 'Food', x: 820 },
    futureapps: { name: 'Future Apps', x: 940 }
  };

  // Router coordinates
  const routerMap: Record<string, { name: string, x: number }> = {
    payment: { name: 'Payment Router', x: 250 },
    messaging: { name: 'Messaging Router', x: 500 },
    other: { name: 'Other Orchestrator', x: 750 }
  };

  // Provider coordinates
  const providerMap: Record<string, { x: number }> = {
    stripe: { x: 80 },
    nmi: { x: 140 },
    pawapay: { x: 200 },
    flutterwave: { x: 260 },
    paychangu: { x: 320 },
    airwallex: { x: 380 },
    
    signalhouse: { x: 460 },
    infobip: { x: 520 },
    futuresms: { x: 580 },
    email: { x: 640 },

    maps: { x: 760 },
    identity: { x: 840 },
    ai: { x: 920 }
  };

  useEffect(() => {
    if (!lastEvent) return;

    // Resolve flow coordinates
    const app = appMap[lastEvent.appId.toLowerCase()];
    const router = routerMap[lastEvent.category];
    const provider = providerMap[lastEvent.providerId.toLowerCase()];

    if (app && router && provider) {
      setActiveFlow({
        id: lastEvent.id,
        appX: app.x,
        routerX: router.x,
        providerX: provider.x,
        status: lastEvent.status
      });

      // Clear the flow highlights after animation completes (1.2s)
      const timer = setTimeout(() => {
        setActiveFlow(null);
      }, 1200);

      return () => clearTimeout(timer);
    }
  }, [lastEvent]);

  // Check if a specific node is currently active in the transaction path
  const isAppActive = (id: string) => activeFlow && lastEvent?.appId.toLowerCase() === id.toLowerCase();
  const isRouterActive = (cat: string) => activeFlow && lastEvent?.category === cat;
  const isProviderActive = (id: string) => activeFlow && lastEvent?.providerId.toLowerCase() === id.toLowerCase();

  return (
    <div className="glass-card" style={{ padding: '16px', position: 'relative' }}>
      <h3 style={{ margin: '0 0 12px 0', fontSize: '18px', fontWeight: '700', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Cpu className="w-5 h-5 text-indigo-400" style={{ color: 'var(--accent-purple)' }} />
        Live Routing Network Topology
      </h3>

      <div className="topology-container" style={{ border: '1px solid rgba(255, 255, 255, 0.03)', borderRadius: '8px', background: '#070a13' }}>
        {/* SVG connection lines layer */}
        <svg 
          viewBox="0 0 1000 480" 
          width="100%" 
          height="100%" 
          style={{ position: 'absolute', top: 0, left: 0, zIndex: 1, pointerEvents: 'none' }}
        >
          <defs>
            <linearGradient id="cyan-glow" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="var(--accent-cyan)" stopOpacity="0.8" />
              <stop offset="100%" stopColor="var(--accent-purple)" stopOpacity="0.8" />
            </linearGradient>
            <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* BACKGROUND MESH: Connects all Apps to Gateway, and Gateway to Routers */}
          {Object.values(appMap).map((app, i) => (
            <line
              key={`app-line-${i}`}
              x1={app.x}
              y1={40}
              x2={500}
              y2={160}
              stroke="rgba(255, 255, 255, 0.04)"
              strokeWidth="1.5"
            />
          ))}

          {Object.values(routerMap).map((router, i) => (
            <line
              key={`router-line-${i}`}
              x1={500}
              y1={160}
              x2={router.x}
              y2={280}
              stroke="rgba(255, 255, 255, 0.04)"
              strokeWidth="1.5"
            />
          ))}

          {/* Connect Payment Router to Payment Providers */}
          {providers.filter(p => p.category === 'payment').map((p) => {
            const coord = providerMap[p.id.toLowerCase()];
            return coord ? (
              <line
                key={`p-line-${p.id}`}
                x1={250}
                y1={280}
                x2={coord.x}
                y2={420}
                stroke={p.status === 'offline' ? 'rgba(239, 68, 68, 0.06)' : 'rgba(255, 255, 255, 0.04)'}
                strokeWidth="1.5"
                strokeDasharray={p.status === 'maintenance' ? '4,4' : undefined}
              />
            ) : null;
          })}

          {/* Connect Messaging Router to Messaging Providers */}
          {providers.filter(p => p.category === 'messaging').map((p) => {
            const coord = providerMap[p.id.toLowerCase()];
            return coord ? (
              <line
                key={`m-line-${p.id}`}
                x1={500}
                y1={280}
                x2={coord.x}
                y2={420}
                stroke={p.status === 'offline' ? 'rgba(239, 68, 68, 0.06)' : 'rgba(255, 255, 255, 0.04)'}
                strokeWidth="1.5"
                strokeDasharray={p.status === 'maintenance' ? '4,4' : undefined}
              />
            ) : null;
          })}

          {/* Connect Other Router to Other Providers */}
          {providers.filter(p => p.category === 'other').map((p) => {
            const coord = providerMap[p.id.toLowerCase()];
            return coord ? (
              <line
                key={`o-line-${p.id}`}
                x1={750}
                y1={280}
                x2={coord.x}
                y2={420}
                stroke={p.status === 'offline' ? 'rgba(239, 68, 68, 0.06)' : 'rgba(255, 255, 255, 0.04)'}
                strokeWidth="1.5"
                strokeDasharray={p.status === 'maintenance' ? '4,4' : undefined}
              />
            ) : null;
          })}

          {/* ACTIVE ROUTE OVERLAY: Draws a thick glowing path for active request */}
          {activeFlow && (
            <>
              {/* Path layout: App -> Gateway -> Router -> Provider */}
              <path
                d={`M ${activeFlow.appX} 40 L 500 160 L ${activeFlow.routerX} 280 L ${activeFlow.providerX} 420`}
                fill="none"
                stroke={activeFlow.status === 'success' ? 'var(--accent-green)' : 'var(--accent-red)'}
                strokeWidth="3.5"
                filter="url(#glow)"
                style={{ opacity: 0.8 }}
              />

              {/* Glowing animated packet */}
              <circle r="7" fill={activeFlow.status === 'success' ? '#34d399' : '#f87171'} filter="url(#glow)">
                <animateMotion
                  key={activeFlow.id}
                  dur="1s"
                  repeatCount="1"
                  path={`M ${activeFlow.appX} 40 L 500 160 L ${activeFlow.routerX} 280 L ${activeFlow.providerX} 420`}
                  fill="freeze"
                />
              </circle>
            </>
          )}
        </svg>

        {/* NODE LABELS & NODES OVERLAY */}
        
        {/* 1. Client Applications (Y = 40px) */}
        {Object.entries(appMap).map(([id, app]) => {
          const isActive = isAppActive(id);
          return (
            <div 
              key={id} 
              className="node" 
              style={{ left: `calc(${app.x}% / 10 - 24px)`, top: '16px' }}
            >
              <div 
                className={`node-circle ${isActive ? 'active' : ''}`}
                style={isActive ? { animation: 'pulse-cyan 1.5s infinite' } : {}}
              >
                <Smartphone className="w-4 h-4 text-slate-400" />
              </div>
              <span className="node-label" style={isActive ? { color: 'var(--accent-cyan)', fontWeight: '700' } : {}}>
                {app.name}
              </span>
            </div>
          );
        })}

        {/* 2. Central API Gateway Node (Y = 160px) */}
        <div 
          className="node" 
          style={{ left: 'calc(50% - 30px)', top: '130px' }}
        >
          <div className="node-circle gateway-node">
            <span style={{ fontSize: '10px', fontWeight: '800', color: 'var(--accent-purple)', letterSpacing: '0.5px' }}>GATEWAY</span>
          </div>
          <span className="node-label" style={{ color: 'var(--accent-purple)', fontWeight: '700' }}>API Gateway</span>
        </div>

        {/* 3. Routers (Y = 280px) */}
        {Object.entries(routerMap).map(([id, router]) => {
          const isActive = isRouterActive(id);
          return (
            <div 
              key={id} 
              className="node" 
              style={{ left: `calc(${router.x}% / 10 - 32px)`, top: '250px' }}
            >
              <div 
                className={`node-circle ${isActive ? 'active' : ''}`}
                style={{ 
                  width: '50px', 
                  height: '50px', 
                  borderRadius: '10px',
                  borderColor: isActive ? 'var(--accent-cyan)' : 'var(--text-muted)'
                }}
              >
                <Cpu className="w-5 h-5 text-slate-400" />
              </div>
              <span className="node-label" style={isActive ? { color: 'var(--accent-cyan)', fontWeight: '700' } : {}}>
                {router.name}
              </span>
            </div>
          );
        })}

        {/* 4. Provider Nodes (Y = 420px) */}
        {providers.map((p) => {
          const coord = providerMap[p.id.toLowerCase()];
          if (!coord) return null;

          const isActive = isProviderActive(p.id);
          const isOffline = p.status === 'offline';
          const isMaint = p.status === 'maintenance';

          return (
            <div 
              key={p.id} 
              className="node" 
              style={{ left: `calc(${coord.x}% / 10 - 20px)`, top: '385px' }}
            >
              <div 
                className={`node-circle ${p.status} ${isActive ? 'active' : ''}`}
                style={{
                  width: '36px',
                  height: '36px',
                  borderWidth: '2px',
                  animation: isActive 
                    ? (activeFlow?.status === 'success' ? 'pulse-green 1s infinite' : 'pulse-red 1s infinite')
                    : undefined
                }}
              >
                {isOffline ? (
                  <ShieldAlert className="w-3.5 h-3.5 text-red-500" />
                ) : (
                  <span style={{ fontSize: '9px', fontWeight: '800' }}>
                    {p.name.substring(0, 2).toUpperCase()}
                  </span>
                )}
              </div>
              <span 
                className="node-label" 
                style={{ 
                  fontSize: '9px',
                  color: isOffline ? 'var(--accent-red)' : isMaint ? 'var(--accent-yellow)' : isActive ? 'var(--accent-green)' : 'var(--text-secondary)'
                }}
              >
                {p.name}
              </span>
            </div>
          );
        })}
      </div>
      
      {/* Topology Legend */}
      <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', marginTop: '10px', fontSize: '11px', color: 'var(--text-secondary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span className="status-dot online"></span> Healthy
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span className="status-dot maintenance"></span> Maintenance
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span className="status-dot offline"></span> Offline
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <ArrowDown className="w-3 h-3 text-cyan-400" /> Glowing packet denotes dynamic path
        </div>
      </div>
    </div>
  );
};

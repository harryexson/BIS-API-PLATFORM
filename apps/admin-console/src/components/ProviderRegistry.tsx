import React, { useState } from 'react';
import { Shield, Sparkles, AlertCircle, RefreshCw } from 'lucide-react';
import { ProviderConfig } from '../types';

interface ProviderRegistryProps {
  providers: ProviderConfig[];
  onUpdateProvider: (id: string, updates: Partial<ProviderConfig>) => Promise<void>;
}

export const ProviderRegistry: React.FC<ProviderRegistryProps> = ({ providers, onUpdateProvider }) => {
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const categories = [
    { key: 'payment', label: 'Payment Integrations (Stripe, PawaPay, etc.)' },
    { key: 'messaging', label: 'Messaging Networks (SignalHouse, Infobip, etc.)' },
    { key: 'other', label: 'Identity, Maps, & AI Engines' }
  ];

  const handleStatusChange = async (id: string, newStatus: any) => {
    setUpdatingId(id);
    await onUpdateProvider(id, { status: newStatus });
    setUpdatingId(null);
  };

  const handleWeightChange = async (id: string, newWeight: number) => {
    setUpdatingId(id);
    await onUpdateProvider(id, { weight: newWeight });
    setUpdatingId(null);
  };

  const handleLatencyChange = async (id: string, min: number, max: number) => {
    setUpdatingId(id);
    await onUpdateProvider(id, { latencyMin: min, latencyMax: max });
    setUpdatingId(null);
  };

  return (
    <div className="glass-card" style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Shield className="w-5 h-5 text-indigo-400" style={{ color: 'var(--accent-purple)' }} />
          Provider Registry Configuration
        </h3>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {categories.map(cat => {
          const catProviders = providers.filter(p => p.category === cat.key);
          
          return (
            <div key={cat.key}>
              <h4 style={{ margin: '0 0 12px 0', fontSize: '13px', color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {cat.label}
              </h4>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {catProviders.map(provider => {
                  const isUpdating = updatingId === provider.id;

                  return (
                    <div 
                      key={provider.id} 
                      style={{
                        background: 'rgba(255, 255, 255, 0.02)',
                        border: '1px solid rgba(255, 255, 255, 0.04)',
                        borderRadius: '8px',
                        padding: '12px 16px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '12px'
                      }}
                    >
                      {/* Name, Category and Status Toggle */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontWeight: '600', fontSize: '14px' }}>{provider.name}</span>
                          <span style={{ fontSize: '10px', background: 'rgba(255, 255, 255, 0.08)', padding: '2px 6px', borderRadius: '4px', color: 'var(--text-secondary)' }}>
                            {provider.id}
                          </span>
                          {isUpdating && <RefreshCw className="w-3 h-3 animate-spin text-cyan-400" style={{ color: 'var(--accent-cyan)' }} />}
                        </div>

                        <select
                          value={provider.status}
                          onChange={(e) => handleStatusChange(provider.id, e.target.value)}
                          style={{
                            background: 'var(--bg-tertiary)',
                            border: '1px solid var(--glass-border)',
                            color: 'var(--text-primary)',
                            padding: '4px 8px',
                            borderRadius: '6px',
                            fontSize: '12px',
                            cursor: 'pointer',
                            outline: 'none'
                          }}
                        >
                          <option value="online">🟢 Online</option>
                          <option value="offline">🔴 Offline</option>
                          <option value="maintenance">🟡 Maintenance</option>
                        </select>
                      </div>

                      {/* Weight and Latency Sliders */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                        {/* Weight Slider (Not for other category since they route by service type directly) */}
                        {provider.category !== 'other' ? (
                          <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                              <span>Priority Weight</span>
                              <span style={{ fontWeight: '600', color: 'var(--accent-cyan)' }}>{provider.weight}</span>
                            </div>
                            <input
                              type="range"
                              min="0"
                              max="100"
                              value={provider.weight}
                              onChange={(e) => handleWeightChange(provider.id, parseInt(e.target.value))}
                              className="slider"
                              style={{ display: 'block' }}
                            />
                          </div>
                        ) : (
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
                            <AlertCircle className="w-3.5 h-3.5 mr-1" />
                            Direct route by service type
                          </div>
                        )}

                        {/* Latency adjustment */}
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                            <span>Simulated Latency</span>
                            <span style={{ fontWeight: '600', color: 'var(--accent-yellow)' }}>
                              {provider.latencyMin}-{provider.latencyMax} ms
                            </span>
                          </div>
                          <input
                            type="range"
                            min="20"
                            max="800"
                            value={provider.latencyMax}
                            onChange={(e) => {
                              const max = parseInt(e.target.value);
                              const min = Math.max(20, Math.floor(max * 0.7)); // Auto scale min latency to keep bounds realistic
                              handleLatencyChange(provider.id, min, max);
                            }}
                            className="slider"
                            style={{ display: 'block' }}
                          />
                        </div>
                      </div>

                      {/* Fee information */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-muted)', borderTop: '1px solid rgba(255, 255, 255, 0.02)', paddingTop: '6px' }}>
                        {provider.category === 'payment' && (
                          <span>
                            Base Fee: {provider.transactionFeePercent}% 
                            {provider.transactionFeeFlat ? ` + $${provider.transactionFeeFlat}` : ''}
                          </span>
                        )}
                        {provider.category === 'messaging' && (
                          <span>Cost per dispatch: ${provider.messageCost}</span>
                        )}
                        {provider.category === 'other' && (
                          <span>Request pricing: Free / Bundled</span>
                        )}
                        <span style={{
                          color: provider.status === 'online' ? 'var(--accent-green)' : provider.status === 'offline' ? 'var(--accent-red)' : 'var(--accent-yellow)'
                        }}>
                          ● {provider.status.toUpperCase()}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

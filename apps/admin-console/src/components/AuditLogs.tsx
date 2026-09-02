import React from 'react';
import { Database, Trash2, ArrowUpRight, AlertCircle } from 'lucide-react';
import { TransactionEvent } from '../types';

interface AuditLogsProps {
  logs: TransactionEvent[];
  onClearLogs: () => Promise<void>;
}

export const AuditLogs: React.FC<AuditLogsProps> = ({ logs, onClearLogs }) => {
  
  const getAppBadgeStyle = (appId: string) => {
    const colors: Record<string, string> = {
      reachchurch: 'rgba(168, 85, 247, 0.1), #c084fc',
      afribook: 'rgba(234, 179, 8, 0.1), #facc15',
      haulpro: 'rgba(249, 115, 22, 0.1), #fb923c',
      stayscape: 'rgba(59, 130, 246, 0.1), #60a5fa',
      eventhub: 'rgba(236, 72, 153, 0.1), #f472b6',
      ridely: 'rgba(16, 185, 129, 0.1), #34d399',
      food: 'rgba(239, 68, 68, 0.1), #f87171',
      futureapps: 'rgba(6, 182, 212, 0.1), #22d3ee'
    };

    const val = colors[appId.toLowerCase()] || 'rgba(255,255,255,0.06), #e5e7eb';
    const [bg, text] = val.split(', ');
    return { backgroundColor: bg, color: text };
  };

  const getCategoryBadgeStyle = (cat: string) => {
    const colors: Record<string, string> = {
      payment: 'rgba(59, 130, 246, 0.1), #60a5fa',
      messaging: 'rgba(6, 182, 212, 0.1), #22d3ee',
      other: 'rgba(168, 85, 247, 0.1), #c084fc'
    };
    const val = colors[cat] || 'rgba(255,255,255,0.06), #e5e7eb';
    const [bg, text] = val.split(', ');
    return { backgroundColor: bg, color: text };
  };

  return (
    <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxHeight: '450px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Database className="w-5 h-5 text-cyan-400" style={{ color: 'var(--accent-cyan)' }} />
          Gateway Transaction Logs
        </h3>
        {logs.length > 0 && (
          <button
            onClick={onClearLogs}
            style={{
              background: 'transparent',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: 'var(--accent-red)',
              padding: '4px 10px',
              borderRadius: '6px',
              fontSize: '11px',
              fontWeight: '600',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              transition: 'background 0.2s ease'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(239, 68, 68, 0.08)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear logs
          </button>
        )}
      </div>

      <div style={{ overflowX: 'auto', flex: 1 }}>
        {logs.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
            <Database className="w-8 h-8 opacity-20" />
            <span>No transactions recorded. Submit requests in the playground to populate logs.</span>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-secondary)', fontWeight: '600' }}>
                <th style={{ padding: '10px 8px' }}>Timestamp</th>
                <th style={{ padding: '10px 8px' }}>Application</th>
                <th style={{ padding: '10px 8px' }}>Service</th>
                <th style={{ padding: '10px 8px' }}>Provider</th>
                <th style={{ padding: '10px 8px' }}>Latency</th>
                <th style={{ padding: '10px 8px' }}>Cost</th>
                <th style={{ padding: '10px 8px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const isSuccess = log.status === 'success';
                const timeStr = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                return (
                  <tr 
                    key={log.id} 
                    style={{ 
                      borderBottom: '1px solid rgba(255,255,255,0.03)',
                      background: isSuccess ? 'transparent' : 'rgba(239, 68, 68, 0.02)'
                    }}
                  >
                    <td style={{ padding: '10px 8px', color: 'var(--text-muted)' }}>{timeStr}</td>
                    <td style={{ padding: '10px 8px' }}>
                      <span 
                        style={{ 
                          padding: '2px 6px', 
                          borderRadius: '4px', 
                          fontSize: '10px', 
                          fontWeight: '700',
                          textTransform: 'capitalize',
                          ...getAppBadgeStyle(log.appId)
                        }}
                      >
                        {log.appId}
                      </span>
                    </td>
                    <td style={{ padding: '10px 8px' }}>
                      <span 
                        style={{ 
                          padding: '2px 6px', 
                          borderRadius: '4px', 
                          fontSize: '10px', 
                          fontWeight: '600',
                          textTransform: 'uppercase',
                          ...getCategoryBadgeStyle(log.category)
                        }}
                      >
                        {log.category}
                      </span>
                    </td>
                    <td style={{ padding: '10px 8px', fontWeight: '600', color: 'var(--text-primary)' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                        {log.providerId}
                        {log.payload?.providerOverride && <ArrowUpRight className="w-3 h-3 text-cyan-400 ml-0.5" />}
                      </span>
                    </td>
                    <td style={{ padding: '10px 8px', color: 'var(--text-secondary)' }}>{log.latency} ms</td>
                    <td style={{ padding: '10px 8px', color: 'var(--text-secondary)' }}>
                      {log.cost > 0 ? `$${log.cost.toFixed(4)}` : '-'}
                    </td>
                    <td style={{ padding: '10px 8px' }}>
                      <span 
                        style={{ 
                          padding: '2px 6px', 
                          borderRadius: '4px', 
                          fontSize: '10px', 
                          fontWeight: '700',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '3px',
                          background: isSuccess ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                          color: isSuccess ? 'var(--accent-green)' : 'var(--accent-red)'
                        }}
                      >
                        {!isSuccess && <AlertCircle className="w-3 h-3" />}
                        {isSuccess ? 'SUCCESS' : 'FAILED'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

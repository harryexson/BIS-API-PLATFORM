import React from 'react';
import { Activity, CheckCircle2, Clock, DollarSign } from 'lucide-react';
import { DashboardMetrics } from '../types';

interface MetricCardsProps {
  metrics: DashboardMetrics;
}

export const MetricCards: React.FC<MetricCardsProps> = ({ metrics }) => {
  const items = [
    {
      title: 'Total Gateway Traffic',
      value: metrics.totalRequests.toLocaleString(),
      subtitle: 'Processed API transactions',
      icon: <Activity className="w-5 h-5" style={{ color: 'var(--accent-cyan)' }} />,
      tint: 'rgba(255, 90, 31, 0.08)'
    },
    {
      title: 'Overall Success Rate',
      value: `${metrics.successRate.toFixed(2)}%`,
      subtitle: 'Dynamic routing completions',
      icon: <CheckCircle2 className="w-5 h-5" style={{ color: 'var(--accent-green)' }} />,
      tint: 'rgba(22, 163, 74, 0.08)'
    },
    {
      title: 'Average Latency',
      value: `${Math.round(metrics.averageLatency)} ms`,
      subtitle: 'End-to-end network duration',
      icon: <Clock className="w-5 h-5" style={{ color: 'var(--text-secondary)' }} />,
      tint: 'var(--bg-tertiary)'
    },
    {
      title: 'Accumulated Routing Cost',
      value: `$${metrics.totalCost.toFixed(5)}`,
      subtitle: 'Provider service charges (USD)',
      icon: <DollarSign className="w-5 h-5" style={{ color: 'var(--text-secondary)' }} />,
      tint: 'var(--bg-tertiary)'
    }
  ];

  return (
    <div className="dashboard-grid">
      {items.map((item, idx) => (
        <div key={idx} className="glass-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)' }}>{item.title}</span>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: item.tint
              }}
            >
              {item.icon}
            </div>
          </div>
          <div>
            <h2 style={{ margin: '0 0 4px 0', fontFamily: 'var(--font-display)', fontSize: '26px', fontWeight: 500, letterSpacing: '-0.01em' }}>
              {item.value}
            </h2>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{item.subtitle}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

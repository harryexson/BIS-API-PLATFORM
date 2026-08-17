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
      icon: <Activity className="w-5 h-5 text-cyan-400" style={{ color: 'var(--accent-cyan)' }} />,
      glowColor: 'rgba(6, 182, 212, 0.15)',
      borderColor: 'rgba(6, 182, 212, 0.2)'
    },
    {
      title: 'Overall Success Rate',
      value: `${metrics.successRate.toFixed(2)}%`,
      subtitle: 'Dynamic routing completions',
      icon: <CheckCircle2 className="w-5 h-5 text-emerald-400" style={{ color: 'var(--accent-green)' }} />,
      glowColor: 'rgba(16, 185, 129, 0.15)',
      borderColor: 'rgba(16, 185, 129, 0.2)'
    },
    {
      title: 'Average Latency',
      value: `${Math.round(metrics.averageLatency)} ms`,
      subtitle: 'End-to-end network duration',
      icon: <Clock className="w-5 h-5 text-yellow-400" style={{ color: 'var(--accent-yellow)' }} />,
      glowColor: 'rgba(245, 158, 11, 0.15)',
      borderColor: 'rgba(245, 158, 11, 0.2)'
    },
    {
      title: 'Accumulated Routing Cost',
      value: `$${metrics.totalCost.toFixed(5)}`,
      subtitle: 'Provider service charges (USD)',
      icon: <DollarSign className="w-5 h-5 text-purple-400" style={{ color: 'var(--accent-purple)' }} />,
      glowColor: 'rgba(168, 85, 247, 0.15)',
      borderColor: 'rgba(168, 85, 247, 0.2)'
    }
  ];

  return (
    <div className="dashboard-grid">
      {items.map((item, idx) => (
        <div
          key={idx}
          className="glass-card"
          style={{
            borderColor: item.borderColor,
            boxShadow: `0 8px 32px 0 rgba(0, 0, 0, 0.2), 0 0 16px ${item.glowColor}`
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <span style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)' }}>{item.title}</span>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: item.glowColor
              }}
            >
              {item.icon}
            </div>
          </div>
          <div>
            <h2 style={{ margin: '0 0 4px 0', fontSize: '28px', fontWeight: '800', letterSpacing: '-0.5px' }}>
              {item.value}
            </h2>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{item.subtitle}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

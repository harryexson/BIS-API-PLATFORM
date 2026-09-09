import React, { useState } from 'react';
import { LifeBuoy, Send, RefreshCw } from 'lucide-react';
import { SupportTicket, SupportTicketMessage } from '../types';

interface SupportDeskProps {
  token: string | null;
}

async function api(url: string, token: string | null, method = 'GET', body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-admin-token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? undefined : res.json();
}

const STATUS_COLOR: Record<string, string> = {
  open: 'var(--accent-yellow)',
  pending: 'var(--accent-cyan)',
  resolved: 'var(--accent-green)',
  closed: 'var(--text-muted)',
};

export const SupportDesk: React.FC<SupportDeskProps> = ({ token }) => {
  const [appId, setAppId] = useState('');
  const [tenantId, setTenantId] = useState('default');
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selected, setSelected] = useState<SupportTicket | null>(null);
  const [messages, setMessages] = useState<SupportTicketMessage[]>([]);
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadTickets = async () => {
    if (!appId.trim()) return;
    setError(null);
    try {
      const data = await api(`/api/dashboard/support/tickets?appId=${encodeURIComponent(appId.trim())}&tenantId=${encodeURIComponent(tenantId.trim() || 'default')}`, token);
      setTickets(data.tickets || []);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const selectTicket = async (ticket: SupportTicket) => {
    setSelected(ticket);
    setError(null);
    try {
      const data = await api(`/api/dashboard/support/tickets/${ticket.id}/messages`, token);
      setMessages(data.messages || []);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const updateStatus = async (status: string) => {
    if (!selected) return;
    setError(null);
    try {
      const data = await api(`/api/dashboard/support/tickets/${selected.id}?appId=${encodeURIComponent(selected.appId)}`, token, 'PATCH', { status });
      setSelected(data.ticket);
      await loadTickets();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const sendReply = async () => {
    if (!selected || !reply.trim()) return;
    setError(null);
    try {
      await api(`/api/dashboard/support/tickets/${selected.id}/messages`, token, 'POST', { body: reply.trim() });
      setReply('');
      await selectTicket(selected);
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="two-col-grid">
      <div className="glass-card">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: 0 }}>
          <LifeBuoy className="w-5 h-5" style={{ color: 'var(--accent-cyan)' }} /> Support tickets
        </h3>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          <input placeholder="application slug" value={appId} onChange={(e) => setAppId(e.target.value)} style={inputStyle} />
          <input placeholder="tenant id" value={tenantId} onChange={(e) => setTenantId(e.target.value)} style={{ ...inputStyle, maxWidth: '120px' }} />
          <button onClick={loadTickets} style={iconOnlyBtn}><RefreshCw className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} /></button>
        </div>

        {error && <div style={errorStyle}>{error}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {tickets.map((t) => (
            <div
              key={t.id}
              onClick={() => selectTicket(t)}
              style={{
                ...rowStyle,
                cursor: 'pointer',
                borderColor: selected?.id === t.id ? 'var(--accent-cyan)' : 'var(--glass-border)',
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{t.subject}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t.requesterEmail}</div>
              </div>
              <span style={{ color: STATUS_COLOR[t.status] || 'var(--text-muted)', fontSize: '12px', fontWeight: 700, textTransform: 'uppercase' }}>
                {t.status}
              </span>
            </div>
          ))}
          {tickets.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No tickets loaded.</span>}
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '16px' }}>
          Thin in-house ticket log. externalProvider/externalRef are reserved for syncing
          with a real helpdesk (Zendesk/Intercom) once connected.
        </p>
      </div>

      <div className="glass-card">
        {!selected && <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Select a ticket to view its thread.</span>}
        {selected && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
              <div>
                <h3 style={{ margin: 0 }}>{selected.subject}</h3>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{selected.requesterEmail} · {selected.priority}</span>
              </div>
              <select value={selected.status} onChange={(e) => updateStatus(e.target.value)} style={inputStyle}>
                <option value="open">open</option>
                <option value="pending">pending</option>
                <option value="resolved">resolved</option>
                <option value="closed">closed</option>
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '16px', maxHeight: '320px', overflowY: 'auto' }}>
              {messages.map((m) => (
                <div key={m.id} style={{ ...rowStyle, alignItems: 'flex-start', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700 }}>
                    {m.authorType} {m.authorEmail ? `· ${m.authorEmail}` : ''}
                  </span>
                  <span style={{ fontSize: '13px' }}>{m.body}</span>
                </div>
              ))}
              {messages.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No messages yet.</span>}
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <input placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
              <button onClick={sendReply} style={btnStyle}><Send className="w-4 h-4" /></button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--glass-border)',
  borderRadius: '8px',
  padding: '8px 12px',
  color: 'var(--text-primary)',
  fontSize: '13px',
};

const btnStyle: React.CSSProperties = {
  background: 'rgba(6,182,212,0.12)',
  border: '1px solid var(--accent-cyan)',
  color: 'var(--accent-cyan)',
  borderRadius: '8px',
  padding: '8px 14px',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
};

const iconOnlyBtn: React.CSSProperties = {
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--glass-border)',
  borderRadius: '8px',
  width: '36px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--glass-border)',
  borderRadius: '8px',
  padding: '10px 12px',
  fontSize: '13px',
};

const errorStyle: React.CSSProperties = {
  background: 'rgba(239,68,68,0.1)',
  border: '1px solid var(--accent-red)',
  color: 'var(--accent-red)',
  borderRadius: '8px',
  padding: '8px 12px',
  fontSize: '13px',
  marginBottom: '16px',
};

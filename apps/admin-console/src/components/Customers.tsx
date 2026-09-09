import React, { useState, useEffect, useCallback } from 'react';
import { Users, StickyNote, Ticket, Plus, MessageSquare, ArrowLeft, ShieldAlert } from 'lucide-react';

interface CustomerSummary {
  application: { id: string; name: string; slug: string; status: string; environment: string; createdAt: string };
  subscription: { id: string; status: string; planId: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  plan: { id: string; slug: string; name: string } | null;
  userCount: number;
  openTicketCount: number;
}

interface CustomerUser {
  id: string;
  email: string;
  name: string | null;
  lastLoginAt: string | null;
  emailVerifiedAt: string | null;
}

interface CustomerNote {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
}

interface SupportTicket {
  id: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  requesterEmail: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface TicketComment {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
}

interface CustomerDetail extends CustomerSummary {
  users: CustomerUser[];
  notes: CustomerNote[];
  tickets: SupportTicket[];
}

interface CustomersProps {
  isAdmin: boolean;
  token: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  open: 'var(--accent-cyan)',
  in_progress: 'var(--accent-yellow)',
  resolved: 'var(--accent-green)',
  closed: 'var(--text-muted)',
};

const PRIORITY_COLORS: Record<string, string> = {
  low: 'var(--text-muted)',
  normal: 'var(--accent-cyan)',
  high: 'var(--accent-yellow)',
  urgent: 'var(--accent-red)',
};

function badge(color: string): React.CSSProperties {
  return {
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '10px',
    fontWeight: 700,
    textTransform: 'uppercase',
    background: `${color}22`,
    color,
    display: 'inline-block',
  };
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

export const Customers: React.FC<CustomersProps> = ({ isAdmin, token }) => {
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [ticketComments, setTicketComments] = useState<Record<string, TicketComment[]>>({});
  const [expandedTicketId, setExpandedTicketId] = useState<string | null>(null);

  const [noteAuthor, setNoteAuthor] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketDescription, setTicketDescription] = useState('');
  const [ticketPriority, setTicketPriority] = useState('normal');
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});

  const adminHeaders: Record<string, string> = token ? { 'x-admin-token': token } : {};

  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/dashboard/customers', { headers: adminHeaders });
      if (res.ok) {
        const data = await res.json();
        setCustomers(data.customers);
      }
    } catch (err) {
      console.error('Failed to fetch customers:', err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const fetchDetail = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/dashboard/customers/${id}`, { headers: adminHeaders });
        if (res.ok) setDetail(await res.json());
      } catch (err) {
        console.error('Failed to fetch customer detail:', err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  );

  useEffect(() => {
    if (isAdmin) fetchCustomers();
  }, [isAdmin, fetchCustomers]);

  useEffect(() => {
    if (selectedId) fetchDetail(selectedId);
    else setDetail(null);
  }, [selectedId, fetchDetail]);

  const handleAddNote = async () => {
    if (!selectedId || !noteBody.trim()) return;
    const res = await fetch(`/api/dashboard/customers/${selectedId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ authorName: noteAuthor || 'Admin', body: noteBody }),
    });
    if (res.ok) {
      setNoteBody('');
      fetchDetail(selectedId);
    }
  };

  const handleCreateTicket = async () => {
    if (!selectedId || !ticketSubject.trim() || !ticketDescription.trim()) return;
    const res = await fetch(`/api/dashboard/customers/${selectedId}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ subject: ticketSubject, description: ticketDescription, priority: ticketPriority }),
    });
    if (res.ok) {
      setTicketSubject('');
      setTicketDescription('');
      setTicketPriority('normal');
      fetchDetail(selectedId);
      fetchCustomers();
    }
  };

  const handleUpdateTicketStatus = async (ticketId: string, status: string) => {
    if (!selectedId) return;
    const res = await fetch(`/api/dashboard/tickets/${ticketId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      fetchDetail(selectedId);
      fetchCustomers();
    }
  };

  const toggleTicket = async (ticketId: string) => {
    if (expandedTicketId === ticketId) {
      setExpandedTicketId(null);
      return;
    }
    setExpandedTicketId(ticketId);
    if (!ticketComments[ticketId]) {
      const res = await fetch(`/api/dashboard/tickets/${ticketId}`, { headers: adminHeaders });
      if (res.ok) {
        const data = await res.json();
        setTicketComments((prev) => ({ ...prev, [ticketId]: data.comments }));
      }
    }
  };

  const handleAddComment = async (ticketId: string) => {
    const body = commentDrafts[ticketId];
    if (!body || !body.trim()) return;
    const res = await fetch(`/api/dashboard/tickets/${ticketId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ authorName: noteAuthor || 'Admin', body }),
    });
    if (res.ok) {
      setCommentDrafts((prev) => ({ ...prev, [ticketId]: '' }));
      const refreshed = await fetch(`/api/dashboard/tickets/${ticketId}`, { headers: adminHeaders });
      if (refreshed.ok) {
        const data = await refreshed.json();
        setTicketComments((prev) => ({ ...prev, [ticketId]: data.comments }));
      }
    }
  };

  if (!isAdmin) {
    return (
      <div className="glass-card" style={{ textAlign: 'center', padding: '48px', color: 'var(--text-secondary)' }}>
        <ShieldAlert className="w-8 h-8" style={{ margin: '0 auto 12px', color: 'var(--accent-yellow)' }} />
        <p>Administrator login is required to view customer records.</p>
      </div>
    );
  }

  if (detail) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <button
          onClick={() => setSelectedId(null)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            background: 'transparent',
            border: 'none',
            color: 'var(--accent-cyan)',
            cursor: 'pointer',
            fontSize: '13px',
            padding: 0,
            width: 'fit-content',
          }}
        >
          <ArrowLeft className="w-4 h-4" /> Back to customers
        </button>

        <div className="glass-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800 }}>{detail.application.name}</h2>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {detail.application.slug} · {detail.application.environment} · {detail.users.length} user{detail.users.length === 1 ? '' : 's'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {detail.plan ? (
                <span style={badge('var(--accent-purple)')}>{detail.plan.name}</span>
              ) : (
                <span style={badge('var(--text-muted)')}>No plan</span>
              )}
              {detail.subscription && <span style={badge('var(--accent-green)')}>{detail.subscription.status}</span>}
            </div>
          </div>

          <div style={{ marginTop: '16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
            {detail.users.map((u) => (
              <div key={u.id} style={{ fontSize: '12px', color: 'var(--text-secondary)', border: '1px solid var(--glass-border)', borderRadius: '8px', padding: '10px' }}>
                <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{u.name || u.email}</div>
                <div>{u.email}</div>
                <div style={{ marginTop: '4px', color: 'var(--text-muted)' }}>
                  Last login: {formatDate(u.lastLoginAt)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="two-col-grid">
          <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <StickyNote className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} /> Notes
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '260px', overflowY: 'auto' }}>
              {detail.notes.length === 0 && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No notes yet.</span>}
              {detail.notes.map((n) => (
                <div key={n.id} style={{ fontSize: '12px', border: '1px solid var(--glass-border)', borderRadius: '8px', padding: '8px' }}>
                  <div style={{ color: 'var(--text-primary)' }}>{n.body}</div>
                  <div style={{ color: 'var(--text-muted)', marginTop: '4px' }}>
                    {n.authorName} · {formatDate(n.createdAt)}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                placeholder="Your name"
                value={noteAuthor}
                onChange={(e) => setNoteAuthor(e.target.value)}
                style={inputStyle({ maxWidth: '110px' })}
              />
              <input
                placeholder="Add a note…"
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddNote()}
                style={inputStyle({ flex: 1 })}
              />
              <button onClick={handleAddNote} style={iconButtonStyle}>
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Ticket className="w-4 h-4" style={{ color: 'var(--accent-cyan)' }} /> Support Tickets
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '320px', overflowY: 'auto' }}>
              {detail.tickets.length === 0 && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No tickets yet.</span>}
              {detail.tickets.map((t) => (
                <div key={t.id} style={{ border: '1px solid var(--glass-border)', borderRadius: '8px', padding: '8px', fontSize: '12px' }}>
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                    onClick={() => toggleTicket(t.id)}
                  >
                    <div>
                      <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{t.subject}</div>
                      <div style={{ color: 'var(--text-muted)' }}>{formatDate(t.createdAt)}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <span style={badge(PRIORITY_COLORS[t.priority] || 'var(--text-muted)')}>{t.priority}</span>
                      <span style={badge(STATUS_COLORS[t.status] || 'var(--text-muted)')}>{t.status}</span>
                    </div>
                  </div>

                  {expandedTicketId === t.id && (
                    <div style={{ marginTop: '10px', borderTop: '1px solid var(--glass-border)', paddingTop: '10px' }}>
                      <p style={{ color: 'var(--text-secondary)', margin: '0 0 8px' }}>{t.description}</p>
                      <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                        {['open', 'in_progress', 'resolved', 'closed'].map((s) => (
                          <button
                            key={s}
                            onClick={() => handleUpdateTicketStatus(t.id, s)}
                            style={{
                              ...smallButtonStyle,
                              opacity: t.status === s ? 1 : 0.55,
                              border: t.status === s ? `1px solid ${STATUS_COLORS[s]}` : '1px solid var(--glass-border)',
                            }}
                          >
                            {s.replace('_', ' ')}
                          </button>
                        ))}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
                        {(ticketComments[t.id] || []).map((c) => (
                          <div key={c.id} style={{ background: 'var(--bg-tertiary)', borderRadius: '6px', padding: '6px 8px' }}>
                            <div style={{ color: 'var(--text-primary)' }}>{c.body}</div>
                            <div style={{ color: 'var(--text-muted)', fontSize: '10px', marginTop: '2px' }}>
                              {c.authorName} · {formatDate(c.createdAt)}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <input
                          placeholder="Reply…"
                          value={commentDrafts[t.id] || ''}
                          onChange={(e) => setCommentDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                          onKeyDown={(e) => e.key === 'Enter' && handleAddComment(t.id)}
                          style={inputStyle({ flex: 1 })}
                        />
                        <button onClick={() => handleAddComment(t.id)} style={iconButtonStyle}>
                          <MessageSquare className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <input
                placeholder="New ticket subject"
                value={ticketSubject}
                onChange={(e) => setTicketSubject(e.target.value)}
                style={inputStyle({})}
              />
              <textarea
                placeholder="Description"
                value={ticketDescription}
                onChange={(e) => setTicketDescription(e.target.value)}
                rows={2}
                style={{ ...inputStyle({}), resize: 'vertical' as const }}
              />
              <div style={{ display: 'flex', gap: '6px' }}>
                <select value={ticketPriority} onChange={(e) => setTicketPriority(e.target.value)} style={inputStyle({ flex: 1 })}>
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
                <button onClick={handleCreateTicket} style={{ ...iconButtonStyle, padding: '6px 14px', width: 'auto' }}>
                  <Plus className="w-4 h-4" /> Ticket
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Users className="w-5 h-5" style={{ color: 'var(--accent-cyan)' }} /> Customers
        </h3>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {loading ? 'Loading…' : `${customers.length} application${customers.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {customers.length === 0 && !loading ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
          No customer applications yet.
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--glass-border)', color: 'var(--text-secondary)', fontWeight: 600 }}>
              <th style={{ padding: '10px 8px' }}>Application</th>
              <th style={{ padding: '10px 8px' }}>Plan</th>
              <th style={{ padding: '10px 8px' }}>Subscription</th>
              <th style={{ padding: '10px 8px' }}>Users</th>
              <th style={{ padding: '10px 8px' }}>Open Tickets</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr
                key={c.application.id}
                onClick={() => setSelectedId(c.application.id)}
                style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer' }}
              >
                <td style={{ padding: '10px 8px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {c.application.name}
                  <div style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '11px' }}>{c.application.slug}</div>
                </td>
                <td style={{ padding: '10px 8px' }}>
                  {c.plan ? <span style={badge('var(--accent-purple)')}>{c.plan.name}</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                </td>
                <td style={{ padding: '10px 8px' }}>
                  {c.subscription ? (
                    <span style={badge(c.subscription.status === 'active' ? 'var(--accent-green)' : 'var(--accent-yellow)')}>
                      {c.subscription.status}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>None</span>
                  )}
                </td>
                <td style={{ padding: '10px 8px', color: 'var(--text-secondary)' }}>{c.userCount}</td>
                <td style={{ padding: '10px 8px' }}>
                  {c.openTicketCount > 0 ? (
                    <span style={badge('var(--accent-red)')}>{c.openTicketCount}</span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

function inputStyle(extra: React.CSSProperties): React.CSSProperties {
  return {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--glass-border)',
    borderRadius: '6px',
    color: 'var(--text-primary)',
    padding: '6px 10px',
    fontSize: '12px',
    outline: 'none',
    ...extra,
  };
}

const iconButtonStyle: React.CSSProperties = {
  background: 'rgba(6,182,212,0.12)',
  border: '1px solid var(--accent-cyan)',
  color: 'var(--accent-cyan)',
  borderRadius: '6px',
  width: '32px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  gap: '4px',
  fontSize: '11px',
  fontWeight: 700,
};

const smallButtonStyle: React.CSSProperties = {
  background: 'var(--bg-tertiary)',
  color: 'var(--text-secondary)',
  borderRadius: '6px',
  padding: '4px 10px',
  fontSize: '10px',
  fontWeight: 700,
  textTransform: 'capitalize',
  cursor: 'pointer',
};

export default Customers;

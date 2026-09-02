import React, { useState } from 'react';
import { Send, Terminal, Play, Cpu, AlertTriangle } from 'lucide-react';
import { ProviderConfig } from '../types';

interface RequestPlaygroundProps {
  providers: ProviderConfig[];
  onRequestSent: (category: 'payment' | 'messaging' | 'other', payload: any) => Promise<void>;
  lastEvent: any;
  loading: boolean;
}

export const RequestPlayground: React.FC<RequestPlaygroundProps> = ({ providers, onRequestSent, lastEvent, loading }) => {
  const [appId, setAppId] = useState('reachchurch');
  const [category, setCategory] = useState<'payment' | 'messaging' | 'other'>('payment');
  
  // Payment States
  const [amount, setAmount] = useState('250.00');
  const [currency, setCurrency] = useState('USD');
  const [paymentMethod, setPaymentMethod] = useState('card');
  const [phoneNumber, setPhoneNumber] = useState('254700000000');
  
  // Messaging States
  const [recipient, setRecipient] = useState('info@reachchurch.org');
  const [content, setContent] = useState('Your verification code for ReachChurch EventHub is 8291.');
  
  // Other States
  const [serviceType, setServiceType] = useState('ai');
  const [prompt, setPrompt] = useState('Explain dynamic API gateway orchestration.');
  
  // Custom Overrides
  const [providerOverride, setProviderOverride] = useState('');

  const apps = [
    { id: 'reachchurch', name: 'ReachChurch' },
    { id: 'afribook', name: 'Afribook' },
    { id: 'haulpro', name: 'HaulPro' },
    { id: 'stayscape', name: 'STAYSCAPE' },
    { id: 'eventhub', name: 'EventHub' },
    { id: 'ridely', name: 'Ride-ly' },
    { id: 'food', name: 'Food' },
    { id: 'futureapps', name: 'Future Apps' }
  ];

  const currencies = [
    { code: 'USD', name: 'US Dollar ($)' },
    { code: 'EUR', name: 'Euro (€)' },
    { code: 'NGN', name: 'Nigerian Naira (₦)' },
    { code: 'KES', name: 'Kenyan Shilling (KSh)' },
    { code: 'MWK', name: 'Malawian Kwacha (MK)' }
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    let payload: any = { appId };
    if (providerOverride) {
      payload.providerOverride = providerOverride;
    }

    if (category === 'payment') {
      payload = {
        ...payload,
        amount: parseFloat(amount),
        currency,
        paymentMethod,
        phoneNumber
      };
    } else if (category === 'messaging') {
      payload = {
        ...payload,
        recipient,
        content
      };
    } else {
      payload = {
        ...payload,
        serviceType,
        payload: serviceType === 'ai' ? { prompt } : serviceType === 'maps' ? { action: 'geocode', address: '1600 Amphitheatre Pkwy' } : { action: 'verify' }
      };
    }

    await onRequestSent(category, payload);
  };

  const handleCategoryChange = (cat: 'payment' | 'messaging' | 'other') => {
    setCategory(cat);
    setProviderOverride(''); // Reset override when switching category
    
    // Auto populate sensible defaults
    if (cat === 'payment') {
      setCurrency('USD');
      setPaymentMethod('card');
    } else if (cat === 'messaging') {
      setRecipient('info@reachchurch.org');
      setContent('Your verification code for ReachChurch EventHub is 8291.');
    } else {
      setServiceType('ai');
      setPrompt('Explain dynamic API gateway orchestration.');
    }
  };

  const filteredOverrides = providers.filter(p => p.category === category);

  return (
    <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Play className="w-5 h-5 text-emerald-400" style={{ color: 'var(--accent-green)' }} />
        Interactive Request Playground
      </h3>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.8fr', gap: '20px' }}>
        {/* Input Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* App Select */}
          <div>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '600' }}>
              Select Client Application
            </label>
            <select
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              style={{
                width: '100%',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--glass-border)',
                color: 'var(--text-primary)',
                padding: '8px 12px',
                borderRadius: '8px',
                fontSize: '13px',
                outline: 'none'
              }}
            >
              {apps.map(app => (
                <option key={app.id} value={app.id}>{app.name}</option>
              ))}
            </select>
          </div>

          {/* Category Tabs */}
          <div>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px', fontWeight: '600' }}>
              Select Gateway Endpoint
            </label>
            <div style={{ display: 'flex', background: 'var(--bg-secondary)', padding: '3px', borderRadius: '8px', gap: '4px' }}>
              {(['payment', 'messaging', 'other'] as const).map(cat => (
                <button
                  type="button"
                  key={cat}
                  onClick={() => handleCategoryChange(cat)}
                  style={{
                    flex: 1,
                    background: category === cat ? 'var(--bg-tertiary)' : 'transparent',
                    border: 'none',
                    color: category === cat ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                    padding: '6px 8px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: '600',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                >
                  {cat.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Dynamic Category Parameters */}
          {category === 'payment' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', background: 'rgba(255,255,255,0.01)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.02)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '8px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '3px' }}>Amount</label>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="100.00"
                    style={{
                      width: '100%',
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--glass-border)',
                      color: 'var(--text-primary)',
                      padding: '6px 10px',
                      borderRadius: '6px',
                      fontSize: '12px',
                      outline: 'none',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '3px' }}>Currency</label>
                  <select
                    value={currency}
                    onChange={(e) => {
                      const cur = e.target.value;
                      setCurrency(cur);
                      // Autofill method/phone based on currency rules
                      if (cur === 'MWK') {
                        setPaymentMethod('mobile_money');
                        setPhoneNumber('265880000000');
                      } else if (['KES', 'GHS'].includes(cur)) {
                        setPaymentMethod('mobile_money');
                        setPhoneNumber(cur === 'KES' ? '254700000000' : '233200000000');
                      } else {
                        setPaymentMethod('card');
                      }
                    }}
                    style={{
                      width: '100%',
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--glass-border)',
                      color: 'var(--text-primary)',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      fontSize: '12px',
                      outline: 'none'
                    }}
                  >
                    {currencies.map(c => (
                      <option key={c.code} value={c.code}>{c.code}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '3px' }}>Payment Rail</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', fontSize: '11px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="paymentMethod"
                      value="card"
                      checked={paymentMethod === 'card'}
                      onChange={() => setPaymentMethod('card')}
                      style={{ marginRight: '4px' }}
                    />
                    Card
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', fontSize: '11px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="paymentMethod"
                      value="mobile_money"
                      checked={paymentMethod === 'mobile_money'}
                      onChange={() => setPaymentMethod('mobile_money')}
                      style={{ marginRight: '4px' }}
                    />
                    Mobile Money
                  </label>
                </div>
              </div>

              {paymentMethod === 'mobile_money' && (
                <div>
                  <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '3px' }}>Phone Number (MSISDN)</label>
                  <input
                    type="text"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    style={{
                      width: '100%',
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--glass-border)',
                      color: 'var(--text-primary)',
                      padding: '6px 10px',
                      borderRadius: '6px',
                      fontSize: '12px',
                      outline: 'none',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {category === 'messaging' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', background: 'rgba(255,255,255,0.01)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.02)' }}>
              <div>
                <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '3px' }}>Recipient Address / Mobile</label>
                <input
                  type="text"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="user@example.com or +15005550006"
                  style={{
                    width: '100%',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--glass-border)',
                    color: 'var(--text-primary)',
                    padding: '6px 10px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    outline: 'none',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '3px' }}>Message Body</label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={3}
                  style={{
                    width: '100%',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--glass-border)',
                    color: 'var(--text-primary)',
                    padding: '6px 10px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    outline: 'none',
                    resize: 'none',
                    boxSizing: 'border-box',
                    fontFamily: 'inherit'
                  }}
                />
              </div>
            </div>
          )}

          {category === 'other' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', background: 'rgba(255,255,255,0.01)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.02)' }}>
              <div>
                <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '3px' }}>API Service Type</label>
                <select
                  value={serviceType}
                  onChange={(e) => {
                    const type = e.target.value;
                    setServiceType(type);
                    if (type === 'ai') setPrompt('Explain dynamic API gateway orchestration.');
                    else if (type === 'maps') setPrompt('1600 Amphitheatre Pkwy');
                  }}
                  style={{
                    width: '100%',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--glass-border)',
                    color: 'var(--text-primary)',
                    padding: '6px 8px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    outline: 'none'
                  }}
                >
                  <option value="ai">🧠 AI Completion (Gemini)</option>
                  <option value="maps">🗺️ Maps Routing & Location</option>
                  <option value="identity">🆔 Identity Validation / Verification</option>
                </select>
              </div>

              {serviceType === 'ai' && (
                <div>
                  <label style={{ display: 'block', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '3px' }}>AI System Prompt</label>
                  <input
                    type="text"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    style={{
                      width: '100%',
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--glass-border)',
                      color: 'var(--text-primary)',
                      padding: '6px 10px',
                      borderRadius: '6px',
                      fontSize: '12px',
                      outline: 'none',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Provider Override Selector */}
          <div>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '600' }}>
              Force Provider Override (Optional)
            </label>
            <select
              value={providerOverride}
              onChange={(e) => setProviderOverride(e.target.value)}
              style={{
                width: '100%',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--glass-border)',
                color: 'var(--text-primary)',
                padding: '8px 12px',
                borderRadius: '8px',
                fontSize: '13px',
                outline: 'none'
              }}
            >
              <option value="">🔮 Automatic Routing Engine Decides</option>
              {filteredOverrides.map(p => (
                <option key={p.id} value={p.id} disabled={p.status === 'offline'}>
                  {p.name} {p.status !== 'online' ? `(${p.status})` : ''}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              background: 'linear-gradient(90deg, #10b981 0%, #059669 100%)',
              border: 'none',
              color: '#ffffff',
              padding: '10px 16px',
              borderRadius: '8px',
              fontWeight: '700',
              cursor: loading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              fontSize: '13px',
              boxShadow: '0 4px 14px 0 rgba(16, 185, 129, 0.3)',
              transition: 'transform 0.1s ease',
              marginTop: '6px'
            }}
            onMouseDown={(e) => !loading && (e.currentTarget.style.transform = 'scale(0.98)')}
            onMouseUp={(e) => !loading && (e.currentTarget.style.transform = 'scale(1)')}
          >
            <Send className="w-4 h-4" />
            {loading ? 'Routing Request...' : 'Dispatch Request'}
          </button>
        </form>

        {/* Live Terminal Output & Routing Traces */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Terminal Console */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: '260px' }}>
            <div style={{ background: '#1e293b', borderTopLeftRadius: '8px', borderTopRightRadius: '8px', padding: '6px 12px', border: '1px solid rgba(255,255,255,0.05)', borderBottom: 'none', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Terminal className="w-4 h-4 text-cyan-400" style={{ color: 'var(--accent-cyan)' }} />
              <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', fontWeight: '600' }}>response_terminal.json</span>
            </div>
            
            <div
              style={{
                flex: 1,
                background: '#0f172a',
                borderBottomLeftRadius: '8px',
                borderBottomRightRadius: '8px',
                border: '1px solid rgba(255,255,255,0.05)',
                padding: '12px',
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                color: '#34d399',
                maxHeight: '280px'
              }}
            >
              {loading ? (
                <div style={{ color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px', height: '100%', justifyContent: 'center' }}>
                  <div className="w-5 h-5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin"></div>
                  <span>Waiting for provider response...</span>
                </div>
              ) : lastEvent ? (
                JSON.stringify(lastEvent.error ? { error: lastEvent.error } : lastEvent.response, null, 2)
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>// Run a request to view JSON response payload</span>
              )}
            </div>
          </div>

          {/* Decision engine details */}
          <div 
            style={{ 
              background: 'rgba(255,255,255,0.02)', 
              border: '1px solid rgba(255,255,255,0.05)', 
              borderRadius: '8px', 
              padding: '12px' 
            }}
          >
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px', fontWeight: '700', textTransform: 'uppercase' }}>
              <Cpu className="w-3.5 h-3.5" />
              Routing Orchestrator Reasoning
            </span>
            <p style={{ margin: 0, fontSize: '12px', lineHeight: '1.4', color: lastEvent?.error ? 'var(--accent-red)' : 'var(--text-secondary)' }}>
              {loading ? (
                <span style={{ animation: 'pulse-text 1.5s infinite' }}>Orchestration engine evaluating rules...</span>
              ) : lastEvent ? (
                lastEvent.decisionReason || 'Automatic match completed successfully.'
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>No decision made yet. Select parameters and send request.</span>
              )}
            </p>
            {lastEvent?.error && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '6px', fontSize: '10px', color: 'var(--accent-red)' }}>
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>Service Unavailable (HTTP 503)</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

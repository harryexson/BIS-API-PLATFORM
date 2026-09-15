import React, { useEffect, useRef, useState } from 'react';
import { Send, Terminal, Play, Cpu, AlertTriangle, CreditCard } from 'lucide-react';
import { ProviderConfig } from '../types';

// Public by design — a Stripe *publishable* key is meant to ship to the
// browser (unlike the secret key the gateway itself uses server-side).
// Unset in most deployments today, since no real checkout flow exists
// elsewhere in this repo yet; when it is set, this becomes the one place
// in the whole platform that can produce a real PaymentRequest.paymentToken
// end to end, rather than every payment adapter having a correct real-HTTP
// path with no real caller that can ever reach it.
const STRIPE_PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;

const STRIPE_JS_SRC = 'https://js.stripe.com/v3/';
let stripeJsPromise: Promise<void> | null = null;

// Loads Stripe.js once and caches the in-flight/settled promise across
// mounts, so switching the "card" rail off and back on doesn't inject a
// second <script> tag or re-fetch it.
function loadStripeJs(): Promise<void> {
  if (window.Stripe) return Promise.resolve();
  if (stripeJsPromise) return stripeJsPromise;

  stripeJsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${STRIPE_JS_SRC}"]`);
    const script = existing || document.createElement('script');
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Failed to load Stripe.js')), { once: true });
    if (!existing) {
      script.src = STRIPE_JS_SRC;
      document.head.appendChild(script);
    }
  });
  return stripeJsPromise;
}

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

  // Real Stripe.js card tokenization — only active when both the "card"
  // rail is selected and VITE_STRIPE_PUBLISHABLE_KEY is configured.
  const cardElementRef = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const cardRef = useRef<StripeCardElement | null>(null);
  const [cardComplete, setCardComplete] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [tokenizing, setTokenizing] = useState(false);
  const cardTokenizationActive = category === 'payment' && paymentMethod === 'card' && !!STRIPE_PUBLISHABLE_KEY;

  useEffect(() => {
    if (!cardTokenizationActive) return;
    let cancelled = false;
    let card: StripeCardElement | null = null;

    // Loaded on demand rather than unconditionally in index.html — most
    // deployments won't have VITE_STRIPE_PUBLISHABLE_KEY configured (no
    // checkout flow exists elsewhere in this repo yet), and an
    // unconditional <script src="https://js.stripe.com/v3/"> would fail
    // to load — and log a console error — in any environment that can't
    // reach js.stripe.com, including this one. Still loaded directly from
    // Stripe's own domain either way, which is what their PCI/fraud-
    // detection requirement actually calls for (not bundling/proxying
    // it), not that the <script> tag be static.
    loadStripeJs()
      .then(() => {
        if (cancelled || !cardElementRef.current) return;
        if (!stripeRef.current) {
          stripeRef.current = window.Stripe!(STRIPE_PUBLISHABLE_KEY!);
        }
        card = stripeRef.current.elements().create('card');
        card.mount(cardElementRef.current);
        card.on('change', (event) => {
          setCardComplete(!event.error);
          setCardError(event.error?.message || null);
        });
        cardRef.current = card;
      })
      .catch(() => {
        if (!cancelled) setCardError('Stripe.js failed to load (js.stripe.com may be unreachable from this environment).');
      });

    return () => {
      cancelled = true;
      card?.unmount();
      cardRef.current = null;
    };
    // Re-mount whenever the card field toggles into/out of view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardTokenizationActive]);

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

      // Real card tokenization: exchange the card details entered into
      // the Stripe Elements field for a PaymentMethod id, client-side,
      // via Stripe.js — this backend never sees or touches raw card data.
      // That id becomes paymentToken, the one thing every real card-based
      // payment adapter (Stripe/NMI/Flutterwave/Airwallex) needs and has
      // never had a real caller supply before now.
      if (cardTokenizationActive) {
        if (!cardComplete || !stripeRef.current || !cardRef.current) {
          setCardError(cardError || 'Enter complete card details before dispatching.');
          return;
        }
        setTokenizing(true);
        try {
          const result = await stripeRef.current.createPaymentMethod({ type: 'card', card: cardRef.current });
          if (result.error || !result.paymentMethod) {
            setCardError(result.error?.message || 'Card tokenization failed.');
            return;
          }
          payload.paymentToken = result.paymentMethod.id;
        } finally {
          setTokenizing(false);
        }
      }
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

              {paymentMethod === 'card' && (
                <div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '3px' }}>
                    <CreditCard className="w-3 h-3" /> Card details {STRIPE_PUBLISHABLE_KEY ? '(real Stripe.js tokenization)' : ''}
                  </label>
                  {STRIPE_PUBLISHABLE_KEY ? (
                    <>
                      <div
                        ref={cardElementRef}
                        style={{
                          background: 'var(--bg-tertiary)',
                          border: `1px solid ${cardError ? 'var(--accent-red)' : 'var(--glass-border)'}`,
                          borderRadius: '6px',
                          padding: '10px',
                        }}
                      />
                      {cardError ? (
                        <p style={{ margin: '4px 0 0', fontSize: '10px', color: 'var(--accent-red)' }}>{cardError}</p>
                      ) : (
                        <p style={{ margin: '4px 0 0', fontSize: '10px', color: 'var(--text-muted)' }}>
                          Test card: 4242 4242 4242 4242, any future expiry, any CVC.
                        </p>
                      )}
                    </>
                  ) : (
                    <p style={{ margin: 0, fontSize: '10px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                      Set <code>VITE_STRIPE_PUBLISHABLE_KEY</code> to test a real tokenized charge here —
                      without it, this request has no card to charge and every real adapter falls back to simulated.
                    </p>
                  )}
                </div>
              )}

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
            disabled={loading || tokenizing || (cardTokenizationActive && !cardComplete)}
            style={{
              background: 'linear-gradient(90deg, #10b981 0%, #059669 100%)',
              border: 'none',
              color: '#ffffff',
              padding: '10px 16px',
              borderRadius: '8px',
              fontWeight: '700',
              cursor: loading || tokenizing ? 'not-allowed' : 'pointer',
              opacity: cardTokenizationActive && !cardComplete ? 0.5 : 1,
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
            {tokenizing ? 'Tokenizing card...' : loading ? 'Routing Request...' : 'Dispatch Request'}
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

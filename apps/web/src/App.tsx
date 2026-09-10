import React from 'react';
import {
  Network,
  CreditCard,
  MessageSquare,
  QrCode,
  ShieldCheck,
  Activity,
  ArrowRight,
  Check,
  Building2,
  Webhook,
  KeyRound,
  LifeBuoy,
} from 'lucide-react';

const FEATURES = [
  {
    icon: CreditCard,
    title: 'Payment orchestration',
    body: 'Route card and mobile-money payments across Stripe, NMI, Flutterwave, PawaPay, PayChangu, and Airwallex through one API, with automatic failover and per-currency capability routing.',
  },
  {
    icon: MessageSquare,
    title: 'Messaging & conversations',
    body: 'SMS, WhatsApp, and email through SignalHouse, Infobip, FutureSMS, and email providers — with shared-number conversation resolution, STOP/HELP/START compliance, and delivery tracking.',
  },
  {
    icon: QrCode,
    title: 'NFC & QR credentials',
    body: 'Issue and verify opaque, tenant-scoped credentials for event check-in, asset and shipment tracking, or membership cards — every scan attempt is recorded for audit, including invalid ones.',
  },
  {
    icon: ShieldCheck,
    title: 'Multi-tenant isolation by default',
    body: 'Every request is scoped by authenticated application and tenant. Cross-tenant access is denied at the query layer, not just the API layer.',
  },
  {
    icon: KeyRound,
    title: 'Role-based access control',
    body: 'Per-application roles and permissions, with effective-permission resolution that never lets one application’s role grant access to another’s resources.',
  },
  {
    icon: Activity,
    title: 'Built-in observability',
    body: 'Structured logs, metrics, and a durable outbox for every payment and message event, so operators can see failures and backlogs before customers report them.',
  },
];

const STEPS = [
  { title: 'Connect your application', body: 'Register your application and get a scoped API key.' },
  { title: 'Send one request', body: 'Payments, messaging, and credentials all go through the same gateway contract.' },
  { title: 'We route it', body: 'Capability-based routing picks a live provider, retries safely, and records the outcome.' },
  { title: 'You get durable state', body: 'Webhooks, receipts, and scan history are persisted before we ever tell you it worked.' },
];

const PLANS = [
  {
    name: 'Starter',
    price: '$0',
    period: 'to get connected',
    description: 'For a single application getting its first integration live.',
    features: ['1 application', 'Payments + messaging routing', 'Community support'],
  },
  {
    name: 'Growth',
    price: '$249',
    period: '/month',
    description: 'For teams running real production traffic across multiple providers.',
    features: ['Unlimited applications', 'NFC/QR credentials', 'RBAC & audit logs', 'Priority support'],
    highlighted: true,
  },
  {
    name: 'Enterprise',
    price: 'Talk to us',
    period: '',
    description: 'For platforms with dedicated compliance, volume, or provider requirements.',
    features: ['Dedicated routing policies', 'Custom provider onboarding', 'SLA-backed support', 'Solutions engineering'],
  },
];

const APPLICATIONS = ['Reach Church', 'Afribook', 'HaulPro'];

export default function App() {
  return (
    <div>
      <Nav />
      <Hero />
      <LogoStrip />
      <Features />
      <HowItWorks />
      <Pricing />
      <CTA />
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <header style={{ borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(8px)', zIndex: 10 }}>
      <div className="container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '72px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontWeight: 800, fontSize: '17px' }}>
          <div style={{ width: '32px', height: '32px', borderRadius: '9px', background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Network className="w-4 h-4" style={{ color: 'white' }} />
          </div>
          BIS API Platform
        </div>
        <nav style={{ display: 'flex', alignItems: 'center', gap: '28px', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>
          <a href="#features">Platform</a>
          <a href="#how-it-works">How it works</a>
          <a href="#pricing">Pricing</a>
          <a href="/admin" className="btn btn-secondary" style={{ padding: '8px 16px' }}>Admin console</a>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section style={{ padding: '96px 0 80px', background: 'radial-gradient(circle at 20% 0%, var(--accent-soft) 0%, transparent 55%)' }}>
      <div className="container" style={{ maxWidth: '760px' }}>
        <span className="pill"><Webhook className="w-3.5 h-3.5" /> One gateway for every BIS application</span>
        <h1 style={{ fontSize: '52px', lineHeight: 1.08, fontWeight: 800, letterSpacing: '-1.5px', margin: '24px 0 20px' }}>
          Payments, messaging, and credentials — one API, every provider.
        </h1>
        <p style={{ fontSize: '19px', color: 'var(--text-secondary)', maxWidth: '620px', marginBottom: '36px' }}>
          Reach Church, Afribook, HaulPro, and every future BIS application connect once
          and get provider failover, multi-tenant isolation, and durable event processing
          for free.
        </p>
        <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
          <a href="#pricing" className="btn btn-primary">Get started <ArrowRight className="w-4 h-4" /></a>
          <a href="/admin" className="btn btn-secondary">Open admin console</a>
        </div>
      </div>
    </section>
  );
}

function LogoStrip() {
  return (
    <section style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
      <div className="container" style={{ display: 'flex', alignItems: 'center', gap: '32px', padding: '24px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Running production traffic for
        </span>
        {APPLICATIONS.map((app) => (
          <span key={app} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, color: 'var(--text-secondary)' }}>
            <Building2 className="w-4 h-4" /> {app}
          </span>
        ))}
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" style={{ padding: '96px 0' }}>
      <div className="container">
        <SectionHeading eyebrow="Platform" title="Everything a BIS application needs from day one" />
        <div className="grid grid-3" style={{ marginTop: '48px' }}>
          {FEATURES.map((f) => (
            <div key={f.title} className="card">
              <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'var(--accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '16px' }}>
                <f.icon className="w-5 h-5" style={{ color: 'var(--accent)' }} />
              </div>
              <h3 style={{ fontSize: '17px', marginBottom: '8px' }}>{f.title}</h3>
              <p style={{ fontSize: '14px', color: 'var(--text-secondary)', margin: 0 }}>{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" style={{ padding: '96px 0', background: 'var(--bg-subtle)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
      <div className="container">
        <SectionHeading eyebrow="How it works" title="Integrate once, route everywhere" />
        <div className="grid grid-4" style={{ marginTop: '48px' }}>
          {STEPS.map((step, i) => (
            <div key={step.title}>
              <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--accent)', marginBottom: '10px' }}>STEP {i + 1}</div>
              <h3 style={{ fontSize: '16px', marginBottom: '6px' }}>{step.title}</h3>
              <p style={{ fontSize: '14px', color: 'var(--text-secondary)', margin: 0 }}>{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section id="pricing" style={{ padding: '96px 0' }}>
      <div className="container">
        <SectionHeading eyebrow="Pricing" title="Simple pricing that scales with your traffic" />
        <div className="grid grid-3" style={{ marginTop: '48px', alignItems: 'stretch' }}>
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className="card"
              style={plan.highlighted ? { borderColor: 'var(--accent)', boxShadow: '0 20px 40px -20px rgba(124,58,237,0.35)' } : undefined}
            >
              {plan.highlighted && <span className="pill" style={{ marginBottom: '16px', borderColor: 'var(--accent)', color: 'var(--accent)' }}>Most popular</span>}
              <h3 style={{ fontSize: '20px', marginBottom: '4px' }}>{plan.name}</h3>
              <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '20px' }}>{plan.description}</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '24px' }}>
                <span style={{ fontSize: '34px', fontWeight: 800 }}>{plan.price}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: '14px' }}>{plan.period}</span>
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 28px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {plan.features.map((f) => (
                  <li key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '14px' }}>
                    <Check className="w-4 h-4" style={{ color: 'var(--accent)', flexShrink: 0, marginTop: '2px' }} /> {f}
                  </li>
                ))}
              </ul>
              <a href="#" className={plan.highlighted ? 'btn btn-primary' : 'btn btn-secondary'} style={{ width: '100%' }}>
                {plan.price === 'Talk to us' ? 'Contact sales' : 'Get started'}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section style={{ padding: '80px 0' }}>
      <div className="container">
        <div
          className="card"
          style={{
            background: 'var(--bg-dark)',
            borderColor: 'var(--bg-dark)',
            color: 'white',
            padding: '56px 48px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '24px',
          }}
        >
          <div>
            <h2 style={{ fontSize: '26px', margin: '0 0 8px' }}>Ready to connect your application?</h2>
            <p style={{ color: '#94a3b8', margin: 0 }}>Support for new applications is coordinated through the admin console.</p>
          </div>
          <a href="/admin" className="btn btn-primary">
            Open admin console <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer style={{ borderTop: '1px solid var(--border)', padding: '40px 0' }}>
      <div className="container" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
        <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>© {new Date().getFullYear()} BIS API Platform</span>
        <div style={{ display: 'flex', gap: '20px', fontSize: '14px', color: 'var(--text-secondary)' }}>
          <a href="/admin" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><ShieldCheck className="w-3.5 h-3.5" /> Admin console</a>
          <a href="#pricing" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><LifeBuoy className="w-3.5 h-3.5" /> Support</a>
        </div>
      </div>
    </footer>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div style={{ maxWidth: '560px' }}>
      <span className="pill">{eyebrow}</span>
      <h2 style={{ fontSize: '32px', fontWeight: 800, letterSpacing: '-0.5px', margin: '16px 0 0' }}>{title}</h2>
    </div>
  );
}

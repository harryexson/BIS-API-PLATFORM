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
import VerifyEmailPage from './pages/VerifyEmailPage';
import ResetPasswordPage from './pages/ResetPasswordPage';

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
  // Plain pathname-based routing — the site is 3 standalone pages (the
  // marketing landing page plus these 2 emailed-link destinations) with no
  // navigation between them, so a router library would be more machinery
  // than the scope needs. apps/web/vercel.json's SPA rewrite makes a direct
  // load of either path work in production; Vite's dev server already
  // does this by default.
  const path = window.location.pathname;
  if (path === '/verify-email') return <VerifyEmailPage />;
  if (path === '/reset-password') return <ResetPasswordPage />;

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
    <header style={{ borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'rgba(255,255,255,0.85)', backdropFilter: 'blur(10px)', zIndex: 10 }}>
      <div className="container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: '76px', paddingBlock: '14px', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'clamp(15px, 4vw, 19px)', whiteSpace: 'nowrap', minWidth: 0 }}>
          <div style={{ width: '38px', height: '38px', borderRadius: '11px', background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 20px -8px var(--accent-glow)', flexShrink: 0 }}>
            <Network style={{ color: 'white', width: '19px', height: '19px' }} />
          </div>
          <span className="nav-wordmark nav-wordmark-full">BIS API Platform</span>
          <span className="nav-wordmark nav-wordmark-short">BIS API</span>
        </div>
        <nav className="nav-actions" style={{ display: 'flex', alignItems: 'center', gap: '36px', fontSize: '15.5px', fontWeight: 600, color: 'var(--text-secondary)', flexShrink: 0 }}>
          <a href="#features" className="nav-link">Platform</a>
          <a href="#how-it-works" className="nav-link">How it works</a>
          <a href="#pricing" className="nav-link">Pricing</a>
          <a href="/admin" className="btn btn-secondary" style={{ padding: '11px 22px', fontSize: '15px', whiteSpace: 'nowrap' }}>Admin console</a>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section style={{ position: 'relative', padding: '120px 0 100px', overflow: 'hidden' }}>
      <div className="bg-grid" style={{ position: 'absolute', inset: 0, zIndex: 0 }} />
      <div
        style={{
          position: 'absolute',
          top: '-180px',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '900px',
          height: '600px',
          background: 'radial-gradient(circle, var(--accent-glow) 0%, transparent 65%)',
          filter: 'blur(40px)',
          zIndex: 0,
        }}
      />
      <div className="container" style={{ position: 'relative', zIndex: 1, maxWidth: '840px' }}>
        <span className="pill"><Webhook className="w-4 h-4" /> One gateway for every BIS application</span>
        <h1
          style={{
            fontSize: 'clamp(2.75rem, 6vw, 4.75rem)',
            lineHeight: 1.05,
            fontWeight: 800,
            letterSpacing: '-2px',
            margin: '32px 0 26px',
          }}
        >
          Payments, messaging, and credentials —<br />
          <span className="gradient-text">one API, every provider.</span>
        </h1>
        <p style={{ fontSize: '21px', lineHeight: 1.6, color: 'var(--text-secondary)', maxWidth: '660px', marginBottom: '44px' }}>
          Reach Church, Afribook, HaulPro, and every future BIS application connect once
          and get provider failover, multi-tenant isolation, and durable event processing
          for free.
        </p>
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
          <a href="#pricing" className="btn btn-primary btn-lg">Get started <ArrowRight className="w-5 h-5" /></a>
          <a href="/admin" className="btn btn-secondary btn-lg">Open admin console</a>
        </div>
      </div>
    </section>
  );
}

function LogoStrip() {
  return (
    <section style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
      <div className="container" style={{ display: 'flex', alignItems: 'center', gap: '40px', padding: '30px 28px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
          Running production traffic for
        </span>
        {APPLICATIONS.map((app) => (
          <span key={app} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '17px', fontWeight: 700, color: 'var(--text-secondary)' }}>
            <Building2 className="w-5 h-5" style={{ width: '22px', height: '22px' }} /> {app}
          </span>
        ))}
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" style={{ padding: '112px 0' }}>
      <div className="container">
        <SectionHeading eyebrow="Platform" title="Everything a BIS application needs from day one" />
        <div className="grid grid-3" style={{ marginTop: '56px' }}>
          {FEATURES.map((f) => (
            <div key={f.title} className="card card-hover">
              <div className="icon-box" style={{ marginBottom: '22px' }}>
                <f.icon />
              </div>
              <h3 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '10px' }}>{f.title}</h3>
              <p style={{ fontSize: '15.5px', lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0 }}>{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" style={{ padding: '112px 0', background: 'var(--bg-subtle)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
      <div className="container">
        <SectionHeading eyebrow="How it works" title="Integrate once, route everywhere" />
        <div className="grid grid-4" style={{ marginTop: '56px' }}>
          {STEPS.map((step, i) => (
            <div key={step.title}>
              <div
                style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '14px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '18px',
                  fontWeight: 800,
                  fontFamily: 'var(--font-display)',
                  color: 'white',
                  background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%)',
                  boxShadow: '0 10px 22px -10px var(--accent-glow)',
                  marginBottom: '18px',
                }}
              >
                {i + 1}
              </div>
              <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px' }}>{step.title}</h3>
              <p style={{ fontSize: '15px', lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0 }}>{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section id="pricing" style={{ padding: '112px 0' }}>
      <div className="container">
        <SectionHeading eyebrow="Pricing" title="Simple pricing that scales with your traffic" />
        <div className="grid grid-3" style={{ marginTop: '56px', alignItems: 'stretch' }}>
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className="card card-hover"
              style={plan.highlighted ? { borderColor: 'var(--accent)', boxShadow: '0 24px 48px -20px rgba(124,58,237,0.35)' } : undefined}
            >
              {plan.highlighted && <span className="pill" style={{ marginBottom: '20px', borderColor: 'var(--accent)', color: 'var(--accent)' }}>Most popular</span>}
              <h3 style={{ fontSize: '23px', fontWeight: 700, marginBottom: '6px' }}>{plan.name}</h3>
              <p style={{ fontSize: '15px', color: 'var(--text-secondary)', marginBottom: '26px' }}>{plan.description}</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '28px' }}>
                <span style={{ fontSize: '42px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{plan.price}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: '15px' }}>{plan.period}</span>
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 32px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {plan.features.map((f) => (
                  <li key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: '15px' }}>
                    <span style={{ width: '22px', height: '22px', borderRadius: '999px', background: 'var(--accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: '1px' }}>
                      <Check className="w-3.5 h-3.5" style={{ color: 'var(--accent-2)', width: '13px', height: '13px' }} />
                    </span>
                    {f}
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
    <section style={{ padding: '96px 0' }}>
      <div className="container">
        <div
          className="card"
          style={{
            position: 'relative',
            overflow: 'hidden',
            background: 'var(--bg-dark)',
            borderColor: 'var(--bg-dark)',
            color: 'white',
            padding: '64px 56px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '28px',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '-120px',
              right: '-80px',
              width: '420px',
              height: '420px',
              background: 'radial-gradient(circle, rgba(124,58,237,0.45) 0%, transparent 70%)',
              filter: 'blur(20px)',
            }}
          />
          <div style={{ position: 'relative', zIndex: 1 }}>
            <h2 style={{ fontSize: 'clamp(1.75rem, 3vw, 2.25rem)', fontWeight: 700, margin: '0 0 12px' }}>Ready to connect your application?</h2>
            <p style={{ color: '#94a3b8', fontSize: '17px', margin: 0 }}>Support for new applications is coordinated through the admin console.</p>
          </div>
          <a href="/admin" className="btn btn-primary btn-lg" style={{ position: 'relative', zIndex: 1 }}>
            Open admin console <ArrowRight className="w-5 h-5" />
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer style={{ borderTop: '1px solid var(--border)', padding: '48px 0' }}>
      <div className="container" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '18px' }}>
        <span style={{ fontSize: '15px', color: 'var(--text-muted)' }}>© {new Date().getFullYear()} BIS API Platform</span>
        <div style={{ display: 'flex', gap: '24px', fontSize: '15px', fontWeight: 600, color: 'var(--text-secondary)' }}>
          <a href="/admin" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><ShieldCheck className="w-4 h-4" /> Admin console</a>
          <a href="#pricing" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><LifeBuoy className="w-4 h-4" /> Support</a>
        </div>
      </div>
    </footer>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div style={{ maxWidth: '620px' }}>
      <span className="pill">{eyebrow}</span>
      <h2 style={{ fontSize: 'clamp(1.9rem, 3.4vw, 2.75rem)', fontWeight: 700, letterSpacing: '-1px', lineHeight: 1.15, margin: '20px 0 0' }}>{title}</h2>
    </div>
  );
}

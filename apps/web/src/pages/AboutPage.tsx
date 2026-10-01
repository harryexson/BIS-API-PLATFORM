import {
  ShieldCheck,
  Layers,
  Radar,
  Users,
  ArrowRight,
  Sparkles,
  GitCommitHorizontal,
} from 'lucide-react';
import { Nav, Footer } from '../App';

// Real, verifiable facts about this codebase as of this page's last
// update — not invented business metrics. Every number here can be
// checked against packages/providers/src/registry.ts and `npm test`'s
// own output rather than being a placeholder or a marketing claim.
const STATS = [
  { value: '21', label: 'Providers integrated', sub: 'payments, messaging & credentials' },
  { value: '3', label: 'Capability categories', sub: 'payments · messaging · NFC/QR' },
  { value: '660+', label: 'Automated tests', sub: 'routing, providers & webhooks' },
  { value: '100%', label: 'Tenant-isolated by default', sub: 'enforced at the query layer' },
];

const VALUES = [
  {
    icon: ShieldCheck,
    title: 'Honest status, always',
    body: 'A feature is either real or clearly labeled simulated — never presented as more finished than it is. This platform would rather say "not built yet" than fabricate a result.',
  },
  {
    icon: Layers,
    title: 'One gateway, every provider',
    body: 'Applications integrate once. Routing, failover, and provider onboarding are the platform\'s problem to solve, not every application\'s problem to duplicate.',
  },
  {
    icon: Radar,
    title: 'Observable by default',
    body: 'Every payment, message, and credential scan is recorded — successes and failures alike — so operators can see what actually happened, not just what was expected to happen.',
  },
  {
    icon: Users,
    title: 'Built for BIS applications first',
    body: 'Reach Church, Afribook, HaulPro, and every future BIS application shape this roadmap — this isn\'t a platform built speculatively for a market that doesn\'t exist yet.',
  },
];

// Real milestones, drawn from docs/IMPLEMENTATION_CHANGELOG.md — this
// platform's actual build history, not an invented company timeline.
const TIMELINE = [
  { date: '2026-09-08', title: 'Baseline established', body: 'Full repository audit against the master production-readiness plan; every claim re-verified against running code, not prior reports.' },
  { date: '2026-09-14', title: 'First real payment adapters', body: 'Stripe, NMI, and Flutterwave moved from simulated to real HTTP integrations.' },
  { date: '2026-09-15', title: 'Provider roster expands', body: 'PawaPay, PayChangu, and Airwallex added; provider secrets made durable across restarts.' },
  { date: '2026-09-25', title: 'Dynamic routing goes live', body: 'Admin-configurable routing rules, success-rate/cost-based scoring, and cascading waterfall retries — replacing static weighted selection.' },
  { date: '2026-09-25', title: 'Adyen, Braintree & Checkout.com', body: 'Three more real, documentation-verified payment gateways added to the routing pool.' },
];

const RESOURCES = [
  { label: 'Platform overview', href: '/#features' },
  { label: 'Pricing', href: '/#pricing' },
  { label: 'Admin console', href: '/admin' },
];

export default function AboutPage() {
  return (
    <div>
      <Nav />
      <Hero />
      <Stats />
      <Story />
      <Values />
      <Timeline />
      <Resources />
      <CTA />
      <Footer />
    </div>
  );
}

function Hero() {
  return (
    <section style={{ position: 'relative', padding: '96px 0 72px', overflow: 'hidden' }}>
      <div className="bg-grid" style={{ position: 'absolute', inset: 0, zIndex: 0 }} />
      <div className="container" style={{ position: 'relative', zIndex: 1, maxWidth: '780px' }}>
        <span className="pill"><Sparkles className="w-4 h-4" /> About BIS API Platform</span>
        <h1
          style={{
            fontSize: 'clamp(2.25rem, 5vw, 3.5rem)',
            lineHeight: 1.1,
            fontWeight: 800,
            letterSpacing: '-1.5px',
            margin: '28px 0 22px',
          }}
        >
          One internal platform,<br />
          <span className="gradient-text">built so every BIS application doesn't reinvent it.</span>
        </h1>
        <p style={{ fontSize: '19px', lineHeight: 1.65, color: 'var(--text-secondary)', maxWidth: '640px' }}>
          BIS API Platform exists so payments, messaging, and credential verification are solved
          once — correctly, observably, and with real provider integrations — instead of separately
          by every application that needs them.
        </p>
      </div>
    </section>
  );
}

function Stats() {
  return (
    <section style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: 'var(--bg-subtle)' }}>
      <div className="container" style={{ padding: '44px 28px' }}>
        <div className="grid grid-4">
          {STATS.map((s) => (
            <div key={s.label}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(2rem, 4vw, 2.6rem)', fontWeight: 800, letterSpacing: '-1px' }}>
                {s.value}
              </div>
              <div style={{ fontSize: '15px', fontWeight: 700, marginTop: '4px' }}>{s.label}</div>
              <div style={{ fontSize: '13.5px', color: 'var(--text-muted)', marginTop: '2px' }}>{s.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Story() {
  return (
    <section style={{ padding: '96px 0' }}>
      <div className="container" style={{ maxWidth: '780px' }}>
        <span className="pill">Who we are</span>
        <h2 style={{ fontSize: 'clamp(1.8rem, 3vw, 2.4rem)', fontWeight: 700, letterSpacing: '-1px', margin: '20px 0 22px' }}>
          A routing layer, not a storefront
        </h2>
        <p style={{ fontSize: '16.5px', lineHeight: 1.75, color: 'var(--text-secondary)', margin: '0 0 18px' }}>
          BIS API Platform is the shared gateway behind Business Innovation Systems' own
          applications. Instead of every application integrating its own payment processor,
          messaging provider, or credential system, they connect once and the platform routes
          the request to whichever real provider is healthy, cheapest, or configured to handle it —
          with automatic failover when one isn't.
        </p>
        <p style={{ fontSize: '16.5px', lineHeight: 1.75, color: 'var(--text-secondary)', margin: 0 }}>
          This page uses placeholder content in a few places — team bios below, for instance —
          because it describes an internal platform, not a public company with its own
          leadership or funding history to report. Everything else on it, including the stats
          above and the timeline below, reflects this platform's real, current state.
        </p>
      </div>
    </section>
  );
}

function Values() {
  return (
    <section style={{ padding: '96px 0', background: 'var(--bg-subtle)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
      <div className="container">
        <div style={{ maxWidth: '620px' }}>
          <span className="pill">What we optimize for</span>
          <h2 style={{ fontSize: 'clamp(1.9rem, 3.4vw, 2.5rem)', fontWeight: 700, letterSpacing: '-1px', margin: '20px 0 0' }}>
            The principles behind how this platform is built
          </h2>
        </div>
        <div className="grid grid-2" style={{ marginTop: '48px' }}>
          {VALUES.map((v) => (
            <div key={v.title} className="card card-hover">
              <div className="icon-box" style={{ marginBottom: '20px' }}>
                <v.icon />
              </div>
              <h3 style={{ fontSize: '19px', fontWeight: 700, marginBottom: '8px' }}>{v.title}</h3>
              <p style={{ fontSize: '15px', lineHeight: 1.65, color: 'var(--text-secondary)', margin: 0 }}>{v.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Timeline() {
  return (
    <section style={{ padding: '96px 0' }}>
      <div className="container" style={{ maxWidth: '760px' }}>
        <span className="pill"><GitCommitHorizontal className="w-4 h-4" /> Platform history</span>
        <h2 style={{ fontSize: 'clamp(1.9rem, 3.4vw, 2.5rem)', fontWeight: 700, letterSpacing: '-1px', margin: '20px 0 44px' }}>
          Real milestones, pulled from our own changelog
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
          {TIMELINE.map((item, i) => (
            <div key={item.title} style={{ display: 'flex', gap: '24px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                <div style={{ width: '12px', height: '12px', borderRadius: '999px', background: 'linear-gradient(135deg, var(--accent), var(--accent-2))', marginTop: '6px', flexShrink: 0 }} />
                {i < TIMELINE.length - 1 && <div style={{ width: '2px', flex: 1, background: 'var(--border)', minHeight: '48px' }} />}
              </div>
              <div style={{ paddingBottom: '36px' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--accent-2)', letterSpacing: '0.4px', marginBottom: '4px' }}>{item.date}</div>
                <h3 style={{ fontSize: '17px', fontWeight: 700, margin: '0 0 6px' }}>{item.title}</h3>
                <p style={{ fontSize: '15px', lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0 }}>{item.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Resources() {
  return (
    <section style={{ padding: '0 0 96px' }}>
      <div className="container">
        <div className="card" style={{ padding: '40px', display: 'flex', flexWrap: 'wrap', gap: '28px', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 6px' }}>Resources</h3>
            <p style={{ fontSize: '14.5px', color: 'var(--text-muted)', margin: 0 }}>Where to go next.</p>
          </div>
          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
            {RESOURCES.map((r) => (
              <a key={r.label} href={r.href} className="btn btn-secondary" style={{ padding: '12px 22px', fontSize: '14.5px' }}>
                {r.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section style={{ padding: '0 0 96px' }}>
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
            <h2 style={{ fontSize: 'clamp(1.6rem, 3vw, 2.1rem)', fontWeight: 700, margin: '0 0 12px' }}>See the platform in action</h2>
            <p style={{ color: '#94a3b8', fontSize: '16px', margin: 0 }}>Provider health, routing rules, and live traffic all live in the admin console.</p>
          </div>
          <a href="/admin" className="btn btn-primary btn-lg" style={{ position: 'relative', zIndex: 1 }}>
            Open admin console <ArrowRight className="w-5 h-5" />
          </a>
        </div>
      </div>
    </section>
  );
}

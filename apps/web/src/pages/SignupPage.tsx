import { useState, type FormEvent } from 'react';
import { KeyRound, Copy, Check, ArrowRight } from 'lucide-react';
import AccountLayout from './AccountLayout';
import { useAuth } from '../auth';

const MIN_PASSWORD_LENGTH = 8; // mirrors packages/database/src/auth-registry.ts's MIN_PASSWORD_LENGTH

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
}

export default function SignupPage() {
  const { signup } = useAuth();
  const [applicationName, setApplicationName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<{ raw: string; prefix: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    setError(null);
    setSubmitting(true);
    const result = await signup({
      email,
      password,
      name: name || undefined,
      applicationName,
      applicationSlug: slugify(applicationName),
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setApiKey(result.apiKey);
  }

  if (apiKey) {
    return (
      <AccountLayout>
        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '56px', height: '56px', borderRadius: '16px', background: 'var(--accent-soft)', marginBottom: '20px' }}>
            <KeyRound className="w-6 h-6" style={{ color: 'var(--accent-2)' }} />
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '22px', fontWeight: 700, margin: '0 0 10px' }}>Account created</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '15px', lineHeight: 1.6, margin: 0 }}>
            Here's your API key — save it now, it won't be shown again.
          </p>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '14px 16px',
            borderRadius: '10px',
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border-strong)',
            marginBottom: '20px',
          }}
        >
          <code style={{ flex: 1, fontSize: '13px', wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace' }}>{apiKey.raw}</code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(apiKey.raw).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--accent-2)', display: 'flex', alignItems: 'center', flexShrink: 0 }}
            aria-label="Copy API key"
          >
            {copied ? <Check style={{ width: '18px', height: '18px' }} /> : <Copy style={{ width: '18px', height: '18px' }} />}
          </button>
        </div>
        <a href="/" className="btn btn-primary" style={{ width: '100%', textDecoration: 'none' }}>
          Continue to dashboard
          <ArrowRight style={{ width: '16px', height: '16px' }} />
        </a>
      </AccountLayout>
    );
  }

  return (
    <AccountLayout>
      <div style={{ textAlign: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '22px', fontWeight: 700, margin: '0 0 10px' }}>Create your account</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '15px', lineHeight: 1.6, margin: 0 }}>
          Set up an application and get an API key to start routing payments and messages.
        </p>
      </div>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <Field label="Company / application name" value={applicationName} onChange={setApplicationName} placeholder="Reach Church" />
        <Field label="Your name (optional)" value={name} onChange={setName} placeholder="Jordan Lee" required={false} />
        <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="you@company.com" />
        <Field label="Password" value={password} onChange={setPassword} type="password" placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`} minLength={MIN_PASSWORD_LENGTH} />
        {error && <p style={{ color: '#dc2626', fontSize: '14px', margin: 0 }}>{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={submitting} style={{ width: '100%', marginTop: '6px' }}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
        <p style={{ textAlign: 'center', fontSize: '14px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
          Already have an account? <a href="/login" style={{ color: 'var(--accent-2)', fontWeight: 600 }}>Sign in</a>
        </p>
      </form>
    </AccountLayout>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  minLength,
  required = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  minLength?: number;
  required?: boolean;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>
      {label}
      <input
        type={type}
        required={required}
        minLength={minLength}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: '12px 14px',
          borderRadius: '10px',
          border: '1px solid var(--border-strong)',
          fontSize: '15px',
          fontFamily: 'inherit',
          color: 'var(--text)',
          outline: 'none',
        }}
      />
    </label>
  );
}

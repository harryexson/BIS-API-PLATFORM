import React, { useState } from 'react';
import { ShieldCheck, Lock, AlertCircle } from 'lucide-react';
import { useAuth } from '../auth';

export const LoginGate: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const { login } = useAuth();
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const result = await login(passcode);
    setLoading(false);
    if (result.ok) {
      onClose?.();
    } else {
      setError(result.error || 'Authentication failed');
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(8, 11, 22, 0.86)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <form
        onSubmit={submit}
        className="glass-card"
        style={{ width: '380px', maxWidth: '90vw', padding: '28px' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <ShieldCheck className="w-6 h-6" style={{ color: 'var(--accent-cyan)' }} />
          <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700' }}>Administrator Access</h3>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 18px' }}>
          Provider management actions require administrator authorization. Enter your admin passcode to continue.
        </p>

        <div style={{ position: 'relative', marginBottom: '14px' }}>
          <Lock
            className="w-4 h-4"
            style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}
          />
          <input
            type="password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="Admin passcode"
            autoFocus
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '10px 12px 10px 36px',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--glass-border)',
              color: 'var(--text-primary)',
              borderRadius: '8px',
              fontSize: '14px',
              outline: 'none',
            }}
          />
        </div>

        {error && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              color: 'var(--accent-red)',
              marginBottom: '12px',
            }}
          >
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !passcode}
          style={{
            width: '100%',
            padding: '10px',
            borderRadius: '8px',
            border: 'none',
            cursor: 'pointer',
            fontWeight: '600',
            fontSize: '14px',
            color: '#04121a',
            background: 'linear-gradient(135deg, var(--accent-cyan) 0%, var(--accent-purple) 100%)',
            opacity: loading || !passcode ? 0.6 : 1,
          }}
        >
          {loading ? 'Verifying…' : 'Authenticate'}
        </button>
      </form>
    </div>
  );
};

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

interface Application {
  id: string;
  name: string;
  slug: string;
}

interface PortalAuthState {
  token: string | null;
  application: Application | null;
  isAuthenticated: boolean;
  signup: (input: { companyName: string; email: string; password: string }) => Promise<{ ok: boolean; error?: string; apiKey?: { prefix: string; raw: string }; token?: string; application?: Application }>;
  login: (input: { email: string; password: string }) => Promise<{ ok: boolean; error?: string }>;
  /** Call once the one-time API key reveal screen has been acknowledged — this
   * is what actually flips isAuthenticated, so signup() itself doesn't jump
   * straight past that screen to the dashboard. */
  completeSignup: (token: string, application: Application) => void;
  logout: () => void;
}

const PortalAuthContext = createContext<PortalAuthState | undefined>(undefined);

const STORAGE_KEY = 'bis_portal_session';

function loadStoredSession(): { token: string; application: Application } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function PortalAuthProvider({ children }: { children: React.ReactNode }) {
  const stored = loadStoredSession();
  const [token, setToken] = useState<string | null>(stored?.token ?? null);
  const [application, setApplication] = useState<Application | null>(stored?.application ?? null);

  const persist = useCallback((token: string, application: Application) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, application }));
    setToken(token);
    setApplication(application);
  }, []);

  const signup = useCallback<PortalAuthState['signup']>(async (input) => {
    try {
      const res = await fetch('/v1/portal/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await res.json();
      if (!res.ok) return { ok: false, error: body.error || 'Signup failed' };
      // Deliberately not persisted yet — see completeSignup().
      return { ok: true, apiKey: body.apiKey, token: body.token, application: body.application };
    } catch {
      return { ok: false, error: 'Network error' };
    }
  }, []);

  const completeSignup = useCallback((token: string, application: Application) => {
    persist(token, application);
  }, [persist]);

  const login = useCallback<PortalAuthState['login']>(async (input) => {
    try {
      const res = await fetch('/v1/portal/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await res.json();
      if (!res.ok) return { ok: false, error: body.error || 'Login failed' };
      persist(body.token, body.application);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error' };
    }
  }, [persist]);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setApplication(null);
  }, []);

  const value = useMemo<PortalAuthState>(
    () => ({ token, application, isAuthenticated: !!token, signup, completeSignup, login, logout }),
    [token, application, signup, completeSignup, login, logout],
  );

  return <PortalAuthContext.Provider value={value}>{children}</PortalAuthContext.Provider>;
}

export function usePortalAuth(): PortalAuthState {
  const ctx = useContext(PortalAuthContext);
  if (!ctx) throw new Error('usePortalAuth must be used within PortalAuthProvider');
  return ctx;
}

/** Fetch wrapper that attaches the portal session token and handles 401 by logging out. */
export async function portalFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 401) {
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  }
  return res;
}

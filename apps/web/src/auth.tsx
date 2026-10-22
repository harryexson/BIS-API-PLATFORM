import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiUrl } from './api';

// Session auth for /v1/api/auth/* + /v1/api/billing/* — the fuller
// customer-lifecycle auth system (email verification, password reset,
// subscription billing), distinct from apps/developer-portal's
// /v1/portal/* tenant-provisioning auth. See services/api-gateway/src/
// app.ts's "CUSTOMER ACCOUNT AUTH ROUTES" / "BILLING ROUTES" sections.

export interface AccountUser {
  id: string;
  applicationId: string;
  tenantId: string | null;
  roleId: string | null;
  email: string;
  name: string | null;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SignupInput {
  email: string;
  password: string;
  name?: string;
  applicationName: string;
  applicationSlug: string;
}

interface SignupApiKey {
  raw: string;
  prefix: string;
  environment: string;
}

interface AuthState {
  token: string | null;
  user: AccountUser | null;
  isAuthenticated: boolean;
  loading: boolean;
  signup: (input: SignupInput) => Promise<
    | { ok: true; apiKey: SignupApiKey; emailVerificationToken?: string }
    | { ok: false; error: string }
  >;
  login: (input: { email: string; password: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);
const STORAGE_KEY = 'bis_account_session';

function loadStoredToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(loadStoredToken());
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchMe = useCallback(async (sessionToken: string): Promise<AccountUser | null> => {
    const res = await fetch(apiUrl('/v1/api/auth/me'), {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.user;
  }, []);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    fetchMe(token).then((u) => {
      if (!u) {
        localStorage.removeItem(STORAGE_KEY);
        setToken(null);
      } else {
        setUser(u);
      }
      setLoading(false);
    });
  }, [token, fetchMe]);

  const login = useCallback<AuthState['login']>(
    async (input) => {
      try {
        const res = await fetch(apiUrl('/v1/api/auth/login'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: body.error || 'Login failed' };
        localStorage.setItem(STORAGE_KEY, body.token);
        setToken(body.token);
        setUser(body.user);
        return { ok: true };
      } catch {
        return { ok: false, error: 'Network error — is the gateway running?' };
      }
    },
    [],
  );

  const signup = useCallback<AuthState['signup']>(
    async (input) => {
      try {
        const res = await fetch(apiUrl('/v1/api/auth/signup'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: body.error || 'Signup failed' };
        // Signup doesn't return a session token (only a one-time-reveal
        // API key) — log in immediately after with the same credentials
        // so the caller lands authenticated once they dismiss the API-key
        // reveal screen, mirroring developer-portal's completeSignup gate.
        await login({ email: input.email, password: input.password });
        return { ok: true, apiKey: body.apiKey, emailVerificationToken: body.emailVerificationToken };
      } catch {
        return { ok: false, error: 'Network error — is the gateway running?' };
      }
    },
    [login],
  );

  const logout = useCallback(() => {
    if (token) {
      fetch(apiUrl('/v1/api/auth/logout'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
    setUser(null);
  }, [token]);

  const refreshUser = useCallback(async () => {
    if (!token) return;
    const u = await fetchMe(token);
    if (u) setUser(u);
  }, [token, fetchMe]);

  const value = useMemo<AuthState>(
    () => ({ token, user, isAuthenticated: !!token && !!user, loading, signup, login, logout, refreshUser }),
    [token, user, loading, signup, login, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Fetch wrapper that attaches the session token; 401 logs out and reloads. */
export async function authFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.status === 401) {
    localStorage.removeItem(STORAGE_KEY);
    window.location.href = '/login';
  }
  return res;
}

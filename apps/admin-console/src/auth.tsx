import React, { createContext, useContext, useState, useCallback } from 'react';

interface AdminAuthState {
  token: string | null;
  isAdmin: boolean;
  login: (passcode: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
}

const AdminAuthContext = createContext<AdminAuthState | null>(null);

const STORAGE_KEY = 'bis_admin_token';

export const AdminAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const login = useCallback(async (passcode: string) => {
    try {
      const res = await fetch('/api/dashboard/admin/verify', {
        headers: { 'x-admin-token': passcode },
      });
      if (!res.ok) {
        return { ok: false, error: 'Invalid administrator credentials' };
      }
      localStorage.setItem(STORAGE_KEY, passcode);
      setToken(passcode);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Unable to reach gateway' };
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
  }, []);

  return (
    <AdminAuthContext.Provider value={{ token, isAdmin: !!token, login, logout }}>
      {children}
    </AdminAuthContext.Provider>
  );
};

export function useAuth(): AdminAuthState {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error('useAuth must be used within AdminAuthProvider');
  return ctx;
}

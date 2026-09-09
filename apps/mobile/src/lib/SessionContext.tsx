import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { GatewaySession, loadSession, saveSession, clearSession } from './secureStore';

interface SessionContextValue {
  session: GatewaySession | null;
  loading: boolean;
  signIn: (session: GatewaySession) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export const SessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<GatewaySession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSession()
      .then(setSession)
      .finally(() => setLoading(false));
  }, []);

  const signIn = useCallback(async (next: GatewaySession) => {
    await saveSession(next);
    setSession(next);
  }, []);

  const signOut = useCallback(async () => {
    await clearSession();
    setSession(null);
  }, []);

  return (
    <SessionContext.Provider value={{ session, loading, signIn, signOut }}>
      {children}
    </SessionContext.Provider>
  );
};

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}

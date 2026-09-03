import { useState } from 'react';
import { usePortalAuth } from './auth';
import AuthScreen from './components/AuthScreen';
import ApiKeys from './components/ApiKeys';
import Transactions from './components/Transactions';
import GettingStarted from './components/GettingStarted';

type Tab = 'start' | 'keys' | 'transactions';

export default function App() {
  const { isAuthenticated, token, application, logout } = usePortalAuth();
  const [tab, setTab] = useState<Tab>('start');

  if (!isAuthenticated || !token || !application) {
    return <AuthScreen />;
  }

  return (
    <div className="main-layout">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>{application.name}</h1>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>{application.slug}</p>
        </div>
        <button className="btn-secondary" onClick={logout}>Sign out</button>
      </div>

      <div className="tabs">
        <div className={`tab ${tab === 'start' ? 'active' : ''}`} onClick={() => setTab('start')}>Getting Started</div>
        <div className={`tab ${tab === 'keys' ? 'active' : ''}`} onClick={() => setTab('keys')}>API Keys</div>
        <div className={`tab ${tab === 'transactions' ? 'active' : ''}`} onClick={() => setTab('transactions')}>Transactions</div>
      </div>

      {tab === 'start' && <GettingStarted appSlug={application.slug} />}
      {tab === 'keys' && <ApiKeys token={token} />}
      {tab === 'transactions' && <Transactions token={token} />}
    </div>
  );
}

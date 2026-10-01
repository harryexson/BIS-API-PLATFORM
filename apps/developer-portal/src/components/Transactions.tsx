import { useEffect, useState } from 'react';
import { portalFetch } from '../auth';

interface Transaction {
  id: string;
  providerId: string;
  status: string;
  amount: string;
  currency: string;
  paymentMethod: string | null;
  createdAt: string;
}

export default function Transactions({ token }: { token: string }) {
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);

  useEffect(() => {
    portalFetch(token, '/v1/portal/transactions')
      .then((res) => res.json())
      .then((body) => setTransactions(body.transactions || []));
  }, [token]);

  return (
    <div>
      <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>Transactions</h2>
      <div className="glass-card">
        {transactions === null ? (
          <p style={{ color: 'var(--text-secondary)' }}>Loading…</p>
        ) : transactions.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)' }}>No transactions yet. Once you process a payment through the API, it'll show up here.</p>
        ) : (
          <table>
            <thead>
              <tr><th>ID</th><th>Provider</th><th>Amount</th><th>Method</th><th>Status</th><th>Date</th></tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td>
                  <td>{t.providerId}</td>
                  <td>{t.amount} {t.currency}</td>
                  <td>{t.paymentMethod || '—'}</td>
                  <td><span className={`status-dot ${t.status}`} />{t.status}</td>
                  <td>{new Date(t.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import {
  Server,
  Shield,
  ShieldOff,
  Activity,
  Globe,
  Coins,
  Cpu,
  Zap,
  HeartPulse,
  Clock,
  AlertTriangle,
  KeyRound,
  Plus,
  Trash2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ArrowLeft,
  Route,
} from 'lucide-react';
import {
  ProviderManagement as ProviderManagementType,
  ProviderSecretMeta,
  RoutingRule,
  HealthCheckSummary,
  ProviderEnvironment,
  ProviderHealthStatus,
} from '../types';

interface ProviderManagementProps {
  providers: ProviderManagementType[];
  isAdmin: boolean;
  token: string | null;
  onRefresh: () => Promise<void>;
}

const HEALTH_COLOR: Record<ProviderHealthStatus, string> = {
  healthy: 'var(--accent-green)',
  degraded: 'var(--accent-yellow)',
  down: 'var(--accent-red)',
  unknown: 'var(--text-muted)',
};

// The named secret fields each real adapter's HTTP calls actually read
// (this.secrets.<field> in packages/providers/src/adapters/**) — lets the
// Add Secret form guide an admin to the right field name instead of a blind
// free-text box. Providers not listed here are simulation-only and don't
// need real credentials (their isConfigured() always returns true).
const PROVIDER_SECRET_FIELDS: Record<string, { field: string; label: string }[]> = {
  stripe: [
    { field: 'api_key', label: 'Secret Key' },
    { field: 'webhook_secret', label: 'Webhook Signing Secret (whsec_...)' },
  ],
  nmi: [
    { field: 'api_key', label: 'API Key' },
    { field: 'gateway_id', label: 'Gateway Hostname (optional, defaults to secure.nmi.com)' },
    { field: 'webhook_secret', label: 'Webhook Signing Key' },
  ],
  flutterwave: [
    { field: 'api_key', label: 'Secret Key' },
    { field: 'webhook_secret', label: 'Webhook Secret Hash (from dashboard webhook settings)' },
  ],
  pawapay: [{ field: 'api_key', label: 'API Key' }],
  paychangu: [
    { field: 'api_key', label: 'API Key' },
    { field: 'webhook_secret', label: 'Webhook Secret (web secret key)' },
  ],
  airwallex: [
    { field: 'client_id', label: 'Client ID' },
    { field: 'api_key', label: 'API Key' },
    { field: 'webhook_secret', label: 'Webhook Secret (per notification URL)' },
  ],
  infobip: [
    { field: 'api_key', label: 'API Key' },
    { field: 'base_url', label: 'Base URL (e.g. xxxx.api.infobip.com)' },
  ],
  africastalking: [
    { field: 'api_key', label: 'API Key' },
    { field: 'username', label: 'Username' },
  ],
  sinch: [
    { field: 'api_key', label: 'API Token' },
    { field: 'service_plan_id', label: 'Service Plan ID' },
  ],
  vibes: [
    { field: 'username', label: 'Username' },
    { field: 'password', label: 'Password' },
  ],
  email: [{ field: 'api_key', label: 'Resend API Key (re_...)' }],
};

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return d.toLocaleString();
}

export const ProviderManagement: React.FC<ProviderManagementProps> = ({
  providers,
  isAdmin,
  token,
  onRefresh,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProviderManagementType | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<ProviderSecretMeta[]>([]);
  const [healthResult, setHealthResult] = useState<HealthCheckSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    ...(token ? { 'x-admin-token': token } : {}),
  });

  const mutate = async (url: string, method: string, body?: any) => {
    const res = await fetch(url, {
      method,
      headers: authHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return res.json();
  };

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      setSecrets([]);
      setHealthResult(null);
      return;
    }
    const provider = providers.find((p) => p.id === selectedId) || null;
    setSelected(provider);
    setHealthResult(null);
    setError(null);
    if (provider && isAdmin) {
      mutate(`/api/dashboard/providers/${provider.id}/secrets`, 'GET')
        .then((data) => setSecrets(data))
        .catch(() => setSecrets([]));
    } else {
      setSecrets([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, providers]);

  const runHealthCheck = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const result = await mutate(`/api/dashboard/providers/${id}/health-check`, 'POST');
      setHealthResult(result);
      await onRefresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const runAllHealthChecks = async () => {
    setBusyId('__all__');
    setError(null);
    try {
      await mutate('/api/dashboard/providers/health-checks', 'POST');
      await onRefresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const patchManagement = async (id: string, updates: any) => {
    setBusyId(id);
    setError(null);
    try {
      await mutate(`/api/dashboard/providers/${id}/management`, 'PATCH', updates);
      await onRefresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const toggleEnabled = (provider: ProviderManagementType) => {
    const nextStatus = provider.status === 'offline' ? 'online' : 'offline';
    patchManagement(provider.id, { status: nextStatus });
  };

  // ---- Routing rule handlers ----
  const [newRuleMatch, setNewRuleMatch] = useState('');
  const [newRuleTarget, setNewRuleTarget] = useState('');
  const [newRuleDescription, setNewRuleDescription] = useState('');

  const addRule = async (providerId: string) => {
    if (!newRuleMatch || !newRuleTarget) {
      setError('A match expression and a target provider are both required');
      return;
    }
    setBusyId(providerId);
    setError(null);
    try {
      await mutate(`/api/dashboard/providers/${providerId}/routing`, 'POST', {
        match: newRuleMatch,
        target: newRuleTarget,
        description: newRuleDescription || undefined,
        enabled: true,
      });
      setNewRuleMatch('');
      setNewRuleTarget('');
      setNewRuleDescription('');
      await onRefresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const updateRule = async (providerId: string, rule: RoutingRule, updates: Partial<RoutingRule>) => {
    setBusyId(providerId);
    setError(null);
    try {
      await mutate(`/api/dashboard/providers/${providerId}/routing/${rule.id}`, 'PATCH', updates);
      await onRefresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const deleteRule = async (providerId: string, ruleId: string) => {
    setBusyId(providerId);
    setError(null);
    try {
      await mutate(`/api/dashboard/providers/${providerId}/routing/${ruleId}`, 'DELETE');
      await onRefresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  // ---- Secret handlers ----
  const [newSecretField, setNewSecretField] = useState('');
  const [newSecretLabel, setNewSecretLabel] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');

  const addSecret = async (providerId: string) => {
    if (!newSecretField || !newSecretLabel || !newSecretValue) {
      setError('Field, label, and value are all required');
      return;
    }
    setBusyId(providerId);
    setError(null);
    try {
      await mutate(`/api/dashboard/providers/${providerId}/secrets`, 'POST', {
        field: newSecretField,
        label: newSecretLabel,
        value: newSecretValue,
      });
      setNewSecretField('');
      setNewSecretLabel('');
      setNewSecretValue('');
      const data = await mutate(`/api/dashboard/providers/${providerId}/secrets`, 'GET');
      setSecrets(data);
      await onRefresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const deleteSecret = async (providerId: string, secretId: string) => {
    setBusyId(providerId);
    setError(null);
    try {
      await mutate(`/api/dashboard/providers/${providerId}/secrets/${secretId}`, 'DELETE');
      setSecrets((prev) => prev.filter((s) => s.id !== secretId));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const readOnly = !isAdmin;

  if (selected) {
    return (
      <ProviderDetail
        provider={selected}
        secrets={secrets}
        healthResult={healthResult}
        isAdmin={isAdmin}
        readOnly={readOnly}
        busyId={busyId}
        error={error}
        token={token}
        onBack={() => setSelectedId(null)}
        onToggleEnabled={() => toggleEnabled(selected)}
        onPatch={(updates) => patchManagement(selected.id, updates)}
        onRunHealthCheck={() => runHealthCheck(selected.id)}
        onAddRule={() => addRule(selected.id)}
        onUpdateRule={(rule, updates) => updateRule(selected.id, rule, updates)}
        onDeleteRule={(rule) => deleteRule(selected.id, rule.id)}
        onAddSecret={() => addSecret(selected.id)}
        onDeleteSecret={(secretId) => deleteSecret(selected.id, secretId)}
        newSecretField={newSecretField}
        setNewSecretField={setNewSecretField}
        newSecretLabel={newSecretLabel}
        setNewSecretLabel={setNewSecretLabel}
        newSecretValue={newSecretValue}
        setNewSecretValue={setNewSecretValue}
        allProviders={providers.map((p) => ({ id: p.id, name: p.name }))}
        newRuleMatch={newRuleMatch}
        setNewRuleMatch={setNewRuleMatch}
        newRuleTarget={newRuleTarget}
        setNewRuleTarget={setNewRuleTarget}
        newRuleDescription={newRuleDescription}
        setNewRuleDescription={setNewRuleDescription}
      />
    );
  }

  const healthyCount = providers.filter((p) => p.health === 'healthy').length;
  const downCount = providers.filter((p) => p.health === 'down').length;
  const onlineCount = providers.filter((p) => p.status === 'online').length;

  return (
    <div className="glass-card" style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
        <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Server className="w-5 h-5" style={{ color: 'var(--accent-purple)' }} />
          Provider Management
        </h3>
        {isAdmin ? (
          <button
            onClick={runAllHealthChecks}
            disabled={busyId === '__all__'}
            style={actionButtonStyle('var(--accent-cyan)')}
          >
            <Activity className="w-4 h-4" />
            {busyId === '__all__' ? 'Checking…' : 'Run All Health Checks'}
          </button>
        ) : (
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Read-only (administrator login required to manage)</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <Stat label="Total" value={String(providers.length)} color="var(--text-primary)" />
        <Stat label="Online" value={String(onlineCount)} color="var(--accent-green)" />
        <Stat label="Healthy" value={String(healthyCount)} color="var(--accent-green)" />
        <Stat label="Down" value={String(downCount)} color="var(--accent-red)" />
      </div>

      {error && (
        <div style={{ color: 'var(--accent-red)', fontSize: '12px', marginBottom: '12px' }}>{error}</div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', minWidth: '1100px' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', borderBottom: '1px solid var(--glass-border)' }}>
              <Th>Provider</Th>
              <Th>Category</Th>
              <Th>Environment</Th>
              <Th>Countries</Th>
              <Th>Currencies</Th>
              <Th>Capabilities</Th>
              <Th>Priority</Th>
              <Th>Configured</Th>
              <Th>Health</Th>
              <Th>Last Success</Th>
              <Th>Err Rate</Th>
              <Th>Latency</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <Td>
                  <div style={{ fontWeight: '600', color: 'var(--text-primary)' }}>{p.name}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{p.id}</div>
                </Td>
                <Td><CategoryBadge category={p.category} /></Td>
                <Td><EnvBadge environment={p.environment} /></Td>
                <Td>{chips(p.countries, 'var(--accent-cyan)')}</Td>
                <Td>{chips(p.currencies, 'var(--accent-yellow)')}</Td>
                <Td>{chips(p.capabilities, 'var(--accent-purple)')}</Td>
                <Td><span style={{ fontWeight: '700' }}>{p.priority}</span></Td>
                <Td><ConfiguredBadge configured={p.configured} providerId={p.id} /></Td>
                <Td>
                  <span style={{ color: HEALTH_COLOR[p.health || 'unknown'], fontWeight: '600', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <HeartPulse className="w-3.5 h-3.5" />
                    {p.health || 'unknown'}
                  </span>
                </Td>
                <Td style={{ color: 'var(--text-secondary)' }}>{formatTimestamp(p.lastSuccessfulRequest)}</Td>
                <Td>
                  <span style={{ color: (p.errorRate || 0) >= 20 ? 'var(--accent-red)' : 'var(--accent-green)', fontWeight: '600' }}>
                    {(p.errorRate || 0).toFixed(1)}%
                  </span>
                </Td>
                <Td style={{ color: 'var(--text-secondary)' }}>{p.latencyMin}-{p.latencyMax} ms</Td>
                <Td>
                  <button onClick={() => setSelectedId(p.id)} style={actionButtonStyle('var(--accent-purple)')}>
                    {readOnly ? 'View' : 'Manage'}
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ----------------------------------------------------
// Detail drawer
// ----------------------------------------------------

interface DetailProps {
  provider: ProviderManagementType;
  secrets: ProviderSecretMeta[];
  healthResult: HealthCheckSummary | null;
  isAdmin: boolean;
  readOnly: boolean;
  busyId: string | null;
  error: string | null;
  token: string | null;
  onBack: () => void;
  onToggleEnabled: () => void;
  onPatch: (updates: any) => void;
  onRunHealthCheck: () => void;
  onAddRule: () => void;
  onUpdateRule: (rule: RoutingRule, updates: Partial<RoutingRule>) => void;
  onDeleteRule: (rule: RoutingRule) => void;
  onAddSecret: () => void;
  onDeleteSecret: (secretId: string) => void;
  newSecretField: string;
  setNewSecretField: (v: string) => void;
  newSecretLabel: string;
  setNewSecretLabel: (v: string) => void;
  newSecretValue: string;
  setNewSecretValue: (v: string) => void;
  allProviders: { id: string; name: string }[];
  newRuleMatch: string;
  setNewRuleMatch: (v: string) => void;
  newRuleTarget: string;
  setNewRuleTarget: (v: string) => void;
  newRuleDescription: string;
  setNewRuleDescription: (v: string) => void;
}

const ProviderDetail: React.FC<DetailProps> = (props) => {
  const {
    provider,
    secrets,
    healthResult,
    isAdmin,
    readOnly,
    busyId,
    error,
    onBack,
    onToggleEnabled,
    onPatch,
    onRunHealthCheck,
    onAddRule,
    onUpdateRule,
    onDeleteRule,
    onAddSecret,
    onDeleteSecret,
    newSecretField,
    setNewSecretField,
    newSecretLabel,
    setNewSecretLabel,
    newSecretValue,
    setNewSecretValue,
    allProviders,
    newRuleMatch,
    setNewRuleMatch,
    newRuleTarget,
    setNewRuleTarget,
    newRuleDescription,
    setNewRuleDescription,
  } = props;

  const knownFields = PROVIDER_SECRET_FIELDS[provider.id];

  const [localCountries, setLocalCountries] = useState(provider.countries.join(', '));
  const [localCurrencies, setLocalCurrencies] = useState(provider.currencies.join(', '));
  const [localCapabilities, setLocalCapabilities] = useState(provider.capabilities.join(', '));

  useEffect(() => {
    setLocalCountries(provider.countries.join(', '));
    setLocalCurrencies(provider.currencies.join(', '));
    setLocalCapabilities(provider.capabilities.join(', '));
  }, [provider.id]);

  const saveCountries = () => onPatch({ countries: parseList(localCountries) });
  const saveCurrencies = () => onPatch({ currencies: parseList(localCurrencies) });
  const saveCapabilities = () => onPatch({ capabilities: parseList(localCapabilities) });

  const disabled = readOnly || busyId === provider.id;

  return (
    <div className="glass-card" style={{ padding: '20px' }}>
      <button onClick={onBack} style={{ ...actionButtonStyle('var(--text-secondary)'), marginBottom: '14px' }}>
        <ArrowLeft className="w-4 h-4" /> Back to list
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px', marginBottom: '18px' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '20px', fontWeight: '700' }}>{provider.name}</h3>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{provider.id} · {provider.category}</div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ color: HEALTH_COLOR[provider.health || 'unknown'], fontWeight: '600', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <HeartPulse className="w-4 h-4" /> {provider.health || 'unknown'}
          </span>
          {isAdmin && (
            <button onClick={onToggleEnabled} disabled={disabled} style={actionButtonStyle(provider.status === 'offline' ? 'var(--accent-green)' : 'var(--accent-red)')}>
              {provider.status === 'offline' ? <Shield className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
              {provider.status === 'offline' ? 'Enable' : 'Disable'}
            </button>
          )}
          {isAdmin && (
            <button onClick={onRunHealthCheck} disabled={disabled} style={actionButtonStyle('var(--accent-cyan)')}>
              <RefreshCw className={`w-4 h-4 ${busyId === provider.id ? 'animate-spin' : ''}`} /> Health Check
            </button>
          )}
        </div>
      </div>

      {readOnly && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
          Viewing in read-only mode. Administrator login is required to modify provider configuration.
        </div>
      )}
      {error && <div style={{ color: 'var(--accent-red)', fontSize: '12px', marginBottom: '12px' }}>{error}</div>}

      {healthResult && (
        <div
          style={{
            fontSize: '12px',
            padding: '10px 12px',
            borderRadius: '8px',
            marginBottom: '16px',
            border: `1px solid ${HEALTH_COLOR[healthResult.status]}`,
            color: HEALTH_COLOR[healthResult.status],
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          <strong>Health check:</strong> {healthResult.status} · {healthResult.latencyMs} ms
          {healthResult.errorMessage ? ` · ${healthResult.errorMessage}` : ''}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        {/* Priority */}
        <Field label="Priority (routing weight)" icon={<Zap className="w-4 h-4" />}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              type="number"
              min={0}
              max={100}
              defaultValue={provider.priority}
              disabled={disabled}
              onBlur={(e) => onPatch({ priority: Number(e.target.value) })}
              style={inputStyle}
            />
          </div>
        </Field>

        {/* Environment */}
        <Field label="Environment" icon={<Globe className="w-4 h-4" />}>
          <select
            defaultValue={provider.environment}
            disabled={disabled}
            onChange={(e) => onPatch({ environment: e.target.value as ProviderEnvironment })}
            style={selectStyle}
          >
            <option value="test">test</option>
            <option value="live">live</option>
          </select>
        </Field>

        {/* Status */}
        <Field label="Status" icon={<Activity className="w-4 h-4" />}>
          <StatusBadge status={provider.status} />
        </Field>

        {/* Configured */}
        <Field label="Credentials" icon={<KeyRound className="w-4 h-4" />}>
          <ConfiguredBadge configured={provider.configured} providerId={provider.id} />
        </Field>

        {/* Error rate */}
        <Field label="Error Rate" icon={<AlertTriangle className="w-4 h-4" />}>
          <span style={{ color: (provider.errorRate || 0) >= 20 ? 'var(--accent-red)' : 'var(--accent-green)', fontWeight: 700 }}>
            {(provider.errorRate || 0).toFixed(1)}%
          </span>
        </Field>

        {/* Last success */}
        <Field label="Last Successful Request" icon={<Clock className="w-4 h-4" />}>
          <span style={{ color: 'var(--text-secondary)' }}>{formatTimestamp(provider.lastSuccessfulRequest)}</span>
        </Field>

        {/* Latency */}
        <Field label="Latency (ms)" icon={<Cpu className="w-4 h-4" />}>
          <span style={{ color: 'var(--text-secondary)' }}>{provider.latencyMin}-{provider.latencyMax}</span>
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginTop: '18px' }}>
        <Field label="Supported Countries" icon={<Globe className="w-4 h-4" />}>
          <textarea value={localCountries} disabled={disabled} onChange={(e) => setLocalCountries(e.target.value)} style={textareaStyle} />
          {isAdmin && <SaveButton onClick={saveCountries} disabled={disabled} label="Save countries" />}
        </Field>

        <Field label="Supported Currencies" icon={<Coins className="w-4 h-4" />}>
          <textarea value={localCurrencies} disabled={disabled} onChange={(e) => setLocalCurrencies(e.target.value)} style={textareaStyle} />
          {isAdmin && <SaveButton onClick={saveCurrencies} disabled={disabled} label="Save currencies" />}
        </Field>

        <Field label="Capabilities" icon={<Cpu className="w-4 h-4" />}>
          <textarea value={localCapabilities} disabled={disabled} onChange={(e) => setLocalCapabilities(e.target.value)} style={textareaStyle} />
          {isAdmin && <SaveButton onClick={saveCapabilities} disabled={disabled} label="Save capabilities" />}
        </Field>
      </div>

      {/* Routing rules — actually consulted by RoutingEngine (packages/
          routing/src/rules.ts): the first enabled rule whose match
          expression holds overrides success-rate/cost-based selection for
          that request. Stored under whichever provider's page created it,
          but target can be any provider id — "IF <match> route to
          <target>" is a general rule, not scoped to this provider. */}
      <Section title="Routing Rules" icon={<Route className="w-4 h-4" />}>
        {provider.routingRules.length === 0 ? (
          <Empty text="No custom routing rules configured." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {provider.routingRules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                allProviders={allProviders}
                disabled={disabled}
                isAdmin={isAdmin}
                onSave={(updates) => onUpdateRule(rule, updates)}
                onToggleEnabled={(enabled) => onUpdateRule(rule, { enabled })}
                onDelete={() => onDeleteRule(rule)}
              />
            ))}
          </div>
        )}

        {isAdmin && (
          <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <input
              placeholder="Match expression (e.g. currency == MWK)"
              value={newRuleMatch}
              disabled={disabled}
              onChange={(e) => setNewRuleMatch(e.target.value)}
              style={{ ...inputStyle, minWidth: '220px' }}
            />
            <select aria-label="New rule target provider" value={newRuleTarget} disabled={disabled} onChange={(e) => setNewRuleTarget(e.target.value)} style={selectStyle}>
              <option value="">Target provider…</option>
              {allProviders.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <input
              aria-label="New rule description"
              placeholder="Description (optional)"
              value={newRuleDescription}
              disabled={disabled}
              onChange={(e) => setNewRuleDescription(e.target.value)}
              style={inputStyle}
            />
            <button onClick={onAddRule} disabled={disabled} style={actionButtonStyle('var(--accent-green)')}>
              <Plus className="w-4 h-4" /> Add Rule
            </button>
          </div>
        )}
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '8px' }}>
          Match syntax: <code>field OP value</code>, optionally joined with{' '}
          <code>AND</code> — e.g. <code>currency == MWK AND amount &gt; 50</code>.
          Fields: <code>currency</code>, <code>amount</code>, <code>paymentMethod</code>{' '}
          (payments), <code>channel</code> (messaging: sms/whatsapp/email). Operators:{' '}
          <code>== != &gt; &gt;= &lt; &lt;=</code>. The first enabled rule that matches wins;
          a rule whose target is offline falls through to normal routing rather than failing the request.
        </div>
      </Section>

      {/* Secrets */}
      <Section title="Secrets" icon={<KeyRound className="w-4 h-4" />}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {secrets.length === 0 ? (
            <Empty text="No secrets registered." />
          ) : (
            secrets.map((s) => (
              <div key={s.id} style={ruleRowStyle}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '12px', color: 'var(--text-primary)' }}>{s.label}</div>
                  <div style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--text-secondary)', letterSpacing: '1px' }}>
                    {s.masked}
                  </div>
                  {s.lastUpdated && (
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>updated {formatTimestamp(s.lastUpdated)}</div>
                  )}
                </div>
                {isAdmin && (
                  <button onClick={() => onDeleteSecret(s.id)} disabled={disabled} style={iconButtonStyle('var(--accent-red)')} title="Delete secret">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))
          )}

          {isAdmin && (
            <div style={{ display: 'flex', gap: '8px', marginTop: '6px', flexWrap: 'wrap' }}>
              {knownFields ? (
                <select
                  value={newSecretField}
                  disabled={disabled}
                  onChange={(e) => {
                    const field = e.target.value;
                    setNewSecretField(field);
                    const known = knownFields.find((f) => f.field === field);
                    if (known && !newSecretLabel) setNewSecretLabel(known.label);
                  }}
                  style={selectStyle}
                >
                  <option value="">Field…</option>
                  {knownFields.map((f) => (
                    <option key={f.field} value={f.field}>{f.field} — {f.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  placeholder="Field (e.g. api_key)"
                  value={newSecretField}
                  disabled={disabled}
                  onChange={(e) => setNewSecretField(e.target.value)}
                  style={inputStyle}
                />
              )}
              <input
                placeholder="Label (e.g. Live API Key)"
                value={newSecretLabel}
                disabled={disabled}
                onChange={(e) => setNewSecretLabel(e.target.value)}
                style={inputStyle}
              />
              <input
                placeholder="Secret value"
                type="password"
                value={newSecretValue}
                disabled={disabled}
                onChange={(e) => setNewSecretValue(e.target.value)}
                style={inputStyle}
              />
              <button onClick={onAddSecret} disabled={disabled} style={actionButtonStyle('var(--accent-green)')}>
                <Plus className="w-4 h-4" /> Add
              </button>
            </div>
          )}
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Shield className="w-3 h-3" /> Secret values are masked and never exposed to the client. Adding or replacing
            a field here takes effect immediately — the adapter reads it on its very next request, no restart required.
          </div>
        </div>
      </Section>
    </div>
  );
};

function RuleRow({
  rule,
  allProviders,
  disabled,
  isAdmin,
  onSave,
  onToggleEnabled,
  onDelete,
}: {
  rule: RoutingRule;
  allProviders: { id: string; name: string }[];
  disabled: boolean;
  isAdmin: boolean;
  onSave: (updates: Partial<RoutingRule>) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const [match, setMatch] = useState(rule.match);
  const [target, setTarget] = useState(rule.target);
  const [description, setDescription] = useState(rule.description ?? '');
  const dirty = match !== rule.match || target !== rule.target || description !== (rule.description ?? '');

  return (
    <div style={{ ...ruleRowStyle, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', flex: 1, alignItems: 'center' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>IF</span>
        <input
          aria-label="Rule match expression"
          value={match}
          disabled={disabled}
          onChange={(e) => setMatch(e.target.value)}
          style={{ ...inputStyle, minWidth: '180px' }}
        />
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>→</span>
        <select aria-label="Rule target provider" value={target} disabled={disabled} onChange={(e) => setTarget(e.target.value)} style={selectStyle}>
          {allProviders.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input
          aria-label="Rule description"
          placeholder="Description (optional)"
          value={description}
          disabled={disabled}
          onChange={(e) => setDescription(e.target.value)}
          style={inputStyle}
        />
        {isAdmin && dirty && (
          <SaveButton
            onClick={() => onSave({ match, target, description: description || undefined })}
            disabled={disabled}
            label="Save"
          />
        )}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-secondary)' }}>
        <input
          type="checkbox"
          checked={rule.enabled}
          disabled={disabled}
          onChange={(e) => onToggleEnabled(e.target.checked)}
        />
        enabled
      </label>
      {isAdmin && (
        <button onClick={onDelete} disabled={disabled} style={iconButtonStyle('var(--accent-red)')} title="Delete rule">
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

// ----------------------------------------------------
// Small UI helpers
// ----------------------------------------------------

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '8px', padding: '10px 14px' }}>
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th style={{ padding: '8px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>{children}</th>;
}
function Td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: '10px', verticalAlign: 'top', ...style }}>{children}</td>;
}

function chips(values: string[] | undefined, color: string) {
  if (!values || values.length === 0) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const shown = values.slice(0, 4);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
      {shown.map((v) => (
        <span key={v} style={{ fontSize: '10px', background: 'rgba(255,255,255,0.06)', color, padding: '2px 6px', borderRadius: '4px' }}>{v}</span>
      ))}
      {values.length > shown.length && (
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>+{values.length - shown.length}</span>
      )}
    </div>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const color = category === 'payment' ? 'var(--accent-green)' : category === 'messaging' ? 'var(--accent-cyan)' : 'var(--accent-purple)';
  return <span style={{ fontSize: '11px', color, fontWeight: 600, textTransform: 'capitalize' }}>{category}</span>;
}

function EnvBadge({ environment }: { environment: ProviderEnvironment }) {
  const color = environment === 'live' ? 'var(--accent-red)' : 'var(--accent-yellow)';
  return <span style={{ fontSize: '11px', color, fontWeight: 600, textTransform: 'uppercase' }}>{environment}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const color = status === 'online' ? 'var(--accent-green)' : status === 'offline' ? 'var(--accent-red)' : 'var(--accent-yellow)';
  return <span style={{ fontSize: '11px', color, fontWeight: 700, textTransform: 'capitalize' }}>{status}</span>;
}

// Whether the adapter has real credentials to make a live API call with —
// distinct from Health, which only reflects past traffic (and a provider
// that's never been called stays "unknown" forever). A simulation-only
// provider (no real HTTP integration — configured is always true for those)
// shows nothing here rather than a misleading "Configured" badge.
function ConfiguredBadge({ configured, providerId }: { configured?: boolean; providerId: string }) {
  const hasRealIntegration = providerId in PROVIDER_SECRET_FIELDS;
  if (!hasRealIntegration) {
    return <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>— (simulated)</span>;
  }
  return configured ? (
    <span style={{ fontSize: '11px', color: 'var(--accent-green)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <CheckCircle2 className="w-3.5 h-3.5" /> Configured
    </span>
  ) : (
    <span style={{ fontSize: '11px', color: 'var(--accent-red)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '4px' }} title="No real credentials — every request falls back to simulated processing">
      <XCircle className="w-3.5 h-3.5" /> Not Configured
    </span>
  );
}

function Field({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '8px', padding: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {icon} {label}
      </div>
      {children}
    </div>
  );
}

function Section({ title, icon, children, onAdd, addLabel, addDisabled }: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onAdd?: () => void;
  addLabel?: string;
  addDisabled?: boolean;
}) {
  return (
    <div style={{ marginTop: '18px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '8px', padding: '14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--accent-cyan)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {icon} {title}
        </div>
        {onAdd && (
          <button onClick={onAdd} disabled={addDisabled} style={actionButtonStyle('var(--accent-green)')}>
            <Plus className="w-4 h-4" /> {addLabel}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>{text}</div>;
}

function SaveButton({ onClick, disabled, label }: { onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...actionButtonStyle('var(--accent-cyan)'), marginTop: '8px' }}>
      <CheckCircle2 className="w-4 h-4" /> {label}
    </button>
  );
}

// ----------------------------------------------------
// Style constants
// ----------------------------------------------------

function actionButtonStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${color}`,
    color,
    padding: '6px 12px',
    borderRadius: '8px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    outline: 'none',
  };
}

function iconButtonStyle(color: string): React.CSSProperties {
  return {
    background: 'transparent',
    border: 'none',
    color,
    cursor: 'pointer',
    padding: '4px',
    display: 'inline-flex',
    alignItems: 'center',
  };
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--glass-border)',
  color: 'var(--text-primary)',
  padding: '8px 10px',
  borderRadius: '6px',
  fontSize: '12px',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: '60px',
  resize: 'vertical',
  fontFamily: 'inherit',
};

const ruleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.04)',
  borderRadius: '8px',
  padding: '8px 10px',
};

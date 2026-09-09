import React, { useState } from 'react';
import { ShieldCheck, Plus, Trash2, Users, KeyRound } from 'lucide-react';
import { Role, Permission } from '../types';

interface RBACManagementProps {
  token: string | null;
}

async function api(url: string, token: string | null, method = 'GET', body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-admin-token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? undefined : res.json();
}

export const RBACManagement: React.FC<RBACManagementProps> = ({ token }) => {
  const [appSlug, setAppSlug] = useState('');
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [newRoleName, setNewRoleName] = useState('');
  const [newResource, setNewResource] = useState('');
  const [newAction, setNewAction] = useState('');
  const [assignUserId, setAssignUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadRoles = async () => {
    if (!appSlug.trim()) return;
    setError(null);
    setLoading(true);
    try {
      const data = await api(`/api/dashboard/applications/${appSlug.trim()}/roles`, token);
      setRoles(data.roles || []);
      setSelectedRole(null);
      setPermissions([]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const selectRole = async (role: Role) => {
    setSelectedRole(role);
    setError(null);
    try {
      const data = await api(`/api/dashboard/roles/${role.id}/permissions`, token);
      setPermissions(data.permissions || []);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const createRole = async () => {
    if (!newRoleName.trim() || !appSlug.trim()) return;
    setError(null);
    try {
      await api(`/api/dashboard/applications/${appSlug.trim()}/roles`, token, 'POST', { name: newRoleName.trim() });
      setNewRoleName('');
      await loadRoles();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const deleteRole = async (id: string) => {
    setError(null);
    try {
      await api(`/api/dashboard/roles/${id}`, token, 'DELETE');
      if (selectedRole?.id === id) {
        setSelectedRole(null);
        setPermissions([]);
      }
      await loadRoles();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const grantPermission = async () => {
    if (!selectedRole || !newResource.trim() || !newAction.trim()) return;
    setError(null);
    try {
      await api(`/api/dashboard/roles/${selectedRole.id}/permissions`, token, 'POST', {
        resource: newResource.trim(),
        action: newAction.trim(),
      });
      setNewResource('');
      setNewAction('');
      await selectRole(selectedRole);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const revokePermission = async (resource: string, action: string) => {
    if (!selectedRole) return;
    setError(null);
    try {
      await api(`/api/dashboard/roles/${selectedRole.id}/permissions/${resource}/${action}`, token, 'DELETE');
      await selectRole(selectedRole);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const assignRole = async () => {
    if (!selectedRole || !assignUserId.trim()) return;
    setError(null);
    try {
      await api(`/api/dashboard/users/${assignUserId.trim()}/roles/${selectedRole.id}`, token, 'POST');
      setAssignUserId('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="two-col-grid">
      <div className="glass-card">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: 0 }}>
          <ShieldCheck className="w-5 h-5" style={{ color: 'var(--accent-cyan)' }} /> Roles
        </h3>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          <input
            placeholder="Application slug (e.g. reach-church)"
            value={appSlug}
            onChange={(e) => setAppSlug(e.target.value)}
            style={inputStyle}
          />
          <button onClick={loadRoles} style={btnStyle} disabled={loading}>Load</button>
        </div>

        {error && <div style={errorStyle}>{error}</div>}

        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          <input
            placeholder="New role name"
            value={newRoleName}
            onChange={(e) => setNewRoleName(e.target.value)}
            style={inputStyle}
          />
          <button onClick={createRole} style={btnStyle}><Plus className="w-4 h-4" /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {roles.map((role) => (
            <div
              key={role.id}
              onClick={() => selectRole(role)}
              style={{
                ...rowStyle,
                borderColor: selectedRole?.id === role.id ? 'var(--accent-cyan)' : 'var(--glass-border)',
                cursor: 'pointer',
              }}
            >
              <span>{role.name}</span>
              <button onClick={(e) => { e.stopPropagation(); deleteRole(role.id); }} style={iconOnlyBtn}>
                <Trash2 className="w-3.5 h-3.5" style={{ color: 'var(--accent-red)' }} />
              </button>
            </div>
          ))}
          {roles.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No roles loaded yet.</span>}
        </div>
      </div>

      <div className="glass-card">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: 0 }}>
          <KeyRound className="w-5 h-5" style={{ color: 'var(--accent-purple)' }} /> Permissions {selectedRole ? `— ${selectedRole.name}` : ''}
        </h3>
        {!selectedRole && <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Select a role to manage its permissions.</span>}
        {selectedRole && (
          <>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
              <input placeholder="resource (e.g. payments)" value={newResource} onChange={(e) => setNewResource(e.target.value)} style={inputStyle} />
              <input placeholder="action (e.g. read)" value={newAction} onChange={(e) => setNewAction(e.target.value)} style={inputStyle} />
              <button onClick={grantPermission} style={btnStyle}><Plus className="w-4 h-4" /></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
              {permissions.map((p) => (
                <div key={p.id} style={rowStyle}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px' }}>{p.resource}:{p.action}</span>
                  <button onClick={() => revokePermission(p.resource, p.action)} style={iconOnlyBtn}>
                    <Trash2 className="w-3.5 h-3.5" style={{ color: 'var(--accent-red)' }} />
                  </button>
                </div>
              ))}
              {permissions.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No permissions granted.</span>}
            </div>

            <h4 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Users className="w-4 h-4" style={{ color: 'var(--accent-green)' }} /> Assign to user
            </h4>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input placeholder="user id (uuid)" value={assignUserId} onChange={(e) => setAssignUserId(e.target.value)} style={inputStyle} />
              <button onClick={assignRole} style={btnStyle}>Assign</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--glass-border)',
  borderRadius: '8px',
  padding: '8px 12px',
  color: 'var(--text-primary)',
  fontSize: '13px',
};

const btnStyle: React.CSSProperties = {
  background: 'rgba(6,182,212,0.12)',
  border: '1px solid var(--accent-cyan)',
  color: 'var(--accent-cyan)',
  borderRadius: '8px',
  padding: '8px 14px',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
};

const iconOnlyBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--glass-border)',
  borderRadius: '8px',
  padding: '10px 12px',
  fontSize: '13px',
};

const errorStyle: React.CSSProperties = {
  background: 'rgba(239,68,68,0.1)',
  border: '1px solid var(--accent-red)',
  color: 'var(--accent-red)',
  borderRadius: '8px',
  padding: '8px 12px',
  fontSize: '13px',
  marginBottom: '16px',
};

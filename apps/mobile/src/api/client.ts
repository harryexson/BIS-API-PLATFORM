import type { GatewaySession } from '../lib/secureStore';
import type { AccessCredential, ApiError, CredentialPurpose, CredentialScan, CredentialType, VerifyScanResponse } from './types';

export class GatewayApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(session: GatewaySession, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${session.baseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.apiKey}`,
      'x-tenant-id': session.tenantId,
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: `Request failed (${res.status})` }))) as ApiError;
    throw new GatewayApiError(body.error || `Request failed (${res.status})`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface IssueCredentialInput {
  purpose: CredentialPurpose;
  ownerType: string;
  ownerRef: string;
  credentialType: CredentialType;
  label?: string;
  expiresAt?: string;
}

export const gatewayApi = {
  issueCredential(session: GatewaySession, input: IssueCredentialInput) {
    return request<{ credential: AccessCredential }>(session, '/v1/api/gateway/credentials', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  listCredentials(session: GatewaySession) {
    return request<{ credentials: AccessCredential[] }>(session, '/v1/api/gateway/credentials');
  },

  revokeCredential(session: GatewaySession, id: string) {
    return request<{ credential: AccessCredential }>(session, `/v1/api/gateway/credentials/${id}/revoke`, {
      method: 'POST',
    });
  },

  listScans(session: GatewaySession, credentialId: string) {
    return request<{ scans: CredentialScan[] }>(session, `/v1/api/gateway/credentials/${credentialId}/scans`);
  },

  verifyCredential(session: GatewaySession, token: string, scannedBy?: string) {
    return request<VerifyScanResponse>(session, '/v1/api/gateway/credentials/verify', {
      method: 'POST',
      body: JSON.stringify({ token, scannedBy }),
    });
  },
};

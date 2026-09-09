export type CredentialPurpose = 'check_in' | 'asset_tracking' | 'membership';
export type CredentialType = 'qr' | 'nfc';
export type CredentialStatus = 'active' | 'revoked' | 'expired';
export type ScanResult = 'valid' | 'unknown' | 'expired' | 'revoked';

export interface AccessCredential {
  id: string;
  appId: string;
  tenantId: string;
  token: string;
  credentialType: CredentialType;
  purpose: CredentialPurpose;
  ownerType: string;
  ownerRef: string;
  label?: string | null;
  status: CredentialStatus;
  issuedAt: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

export interface CredentialScan {
  id: string;
  credentialId: string | null;
  result: ScanResult;
  scannedAt: string;
  scannedBy?: string | null;
}

export interface VerifyScanResponse {
  result: ScanResult;
  credential?: AccessCredential;
}

export interface ApiError {
  error: string;
}

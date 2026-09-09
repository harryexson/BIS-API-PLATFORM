import { accessCredentialRepository } from './access-credentials';
import { credentialScanRepository } from './credential-scans';
import type { AccessCredential } from '../schema';

export type ScanResult = 'valid' | 'unknown' | 'expired' | 'revoked';

export interface VerifyScanInput {
  appId: string;
  tenantId: string;
  token: string;
  scannedBy?: string;
  deviceInfo?: string;
  metadata?: Record<string, unknown>;
}

export interface VerifyScanOutput {
  result: ScanResult;
  credential?: AccessCredential;
}

/**
 * The single place that decides whether a scanned QR/NFC token is valid.
 * Every outcome — including "unknown token" and "wrong app" — is recorded
 * in credential_scans so check-in/asset-tracking/loyalty scans are always
 * auditable, not just the successful ones.
 */
export async function verifyCredentialScan(input: VerifyScanInput): Promise<VerifyScanOutput> {
  const credential = await accessCredentialRepository.findByTokenForApp(input.token, input.appId);

  let result: ScanResult;
  if (!credential) {
    result = 'unknown';
  } else if (credential.status === 'revoked') {
    result = 'revoked';
  } else if (credential.expiresAt && credential.expiresAt.getTime() < Date.now()) {
    result = 'expired';
  } else {
    result = 'valid';
  }

  await credentialScanRepository.record({
    credentialId: credential?.id ?? null,
    appId: input.appId,
    tenantId: input.tenantId,
    result,
    scannedBy: input.scannedBy,
    deviceInfo: input.deviceInfo,
    metadata: input.metadata,
  });

  return { result, credential };
}

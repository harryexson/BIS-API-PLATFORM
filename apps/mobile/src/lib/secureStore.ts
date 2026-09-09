import * as SecureStore from 'expo-secure-store';

/**
 * Gateway connection details, kept in the OS keychain/keystore rather than
 * AsyncStorage or plain state — this is an API key with real production
 * access, not a UI preference.
 */
export interface GatewaySession {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
}

const KEYS = {
  baseUrl: 'bis_gateway_base_url',
  apiKey: 'bis_gateway_api_key',
  tenantId: 'bis_gateway_tenant_id',
} as const;

export async function loadSession(): Promise<GatewaySession | null> {
  const [baseUrl, apiKey, tenantId] = await Promise.all([
    SecureStore.getItemAsync(KEYS.baseUrl),
    SecureStore.getItemAsync(KEYS.apiKey),
    SecureStore.getItemAsync(KEYS.tenantId),
  ]);
  if (!baseUrl || !apiKey || !tenantId) return null;
  return { baseUrl, apiKey, tenantId };
}

export async function saveSession(session: GatewaySession): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEYS.baseUrl, session.baseUrl),
    SecureStore.setItemAsync(KEYS.apiKey, session.apiKey),
    SecureStore.setItemAsync(KEYS.tenantId, session.tenantId),
  ]);
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEYS.baseUrl),
    SecureStore.deleteItemAsync(KEYS.apiKey),
    SecureStore.deleteItemAsync(KEYS.tenantId),
  ]);
}

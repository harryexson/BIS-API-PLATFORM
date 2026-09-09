import NfcManager, { NfcTech, Ndef } from 'react-native-nfc-manager';

let started = false;

async function ensureStarted(): Promise<void> {
  if (started) return;
  await NfcManager.start();
  started = true;
}

export async function isNfcSupported(): Promise<boolean> {
  try {
    await ensureStarted();
    return await NfcManager.isSupported();
  } catch {
    return false;
  }
}

/**
 * Writes a single text NDEF record containing the credential token to a
 * nearby tag. Callers should present a "hold your device near the tag" UI
 * while this promise is pending — it resolves once the phone detects a tag.
 */
export async function writeTokenToTag(token: string): Promise<void> {
  await ensureStarted();
  await NfcManager.requestTechnology(NfcTech.Ndef);
  try {
    const bytes = Ndef.encodeMessage([Ndef.textRecord(token)]);
    await NfcManager.ndefHandler.writeNdefMessage(bytes);
  } finally {
    await NfcManager.cancelTechnologyRequest();
  }
}

/**
 * Reads the first text NDEF record off a nearby tag and returns it as the
 * credential token. Returns null if the tag has no readable text record.
 */
export async function readTokenFromTag(): Promise<string | null> {
  await ensureStarted();
  await NfcManager.requestTechnology(NfcTech.Ndef);
  try {
    const tag = await NfcManager.getTag();
    const record = tag?.ndefMessage?.[0];
    if (!record) return null;
    return Ndef.text.decodePayload(new Uint8Array(record.payload));
  } finally {
    await NfcManager.cancelTechnologyRequest();
  }
}

export async function cancelNfcOperation(): Promise<void> {
  try {
    await NfcManager.cancelTechnologyRequest();
  } catch {
    // no request in flight — nothing to cancel
  }
}

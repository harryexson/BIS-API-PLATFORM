import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable, ActivityIndicator, ScrollView, Alert } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Wifi, QrCode as QrCodeIcon } from 'lucide-react-native';
import { colors, spacing } from '../theme';
import { useSession } from '../lib/SessionContext';
import { gatewayApi } from '../api/client';
import { writeTokenToTag } from '../lib/nfc';
import type { AccessCredential, CredentialPurpose, CredentialType } from '../api/types';

const PURPOSES: { value: CredentialPurpose; label: string }[] = [
  { value: 'check_in', label: 'Event check-in' },
  { value: 'asset_tracking', label: 'Asset / shipment tracking' },
  { value: 'membership', label: 'Membership / loyalty' },
];

export default function IssueScreen() {
  const { session } = useSession();
  const [purpose, setPurpose] = useState<CredentialPurpose>('check_in');
  const [credentialType, setCredentialType] = useState<CredentialType>('qr');
  const [ownerType, setOwnerType] = useState('attendee');
  const [ownerRef, setOwnerRef] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [nfcWriting, setNfcWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<AccessCredential | null>(null);

  const handleIssue = async () => {
    if (!session || !ownerRef.trim()) {
      setError('Owner reference is required.');
      return;
    }
    setBusy(true);
    setError(null);
    setIssued(null);
    try {
      const { credential } = await gatewayApi.issueCredential(session, {
        purpose,
        credentialType,
        ownerType: ownerType.trim() || 'unknown',
        ownerRef: ownerRef.trim(),
        label: label.trim() || undefined,
      });
      setIssued(credential);
    } catch (err: any) {
      setError(err.message || 'Failed to issue credential');
    } finally {
      setBusy(false);
    }
  };

  const handleWriteNfc = async () => {
    if (!issued) return;
    setNfcWriting(true);
    setError(null);
    try {
      await writeTokenToTag(issued.token);
      Alert.alert('Written', 'Credential written to the NFC tag.');
    } catch (err: any) {
      setError(err.message || 'Failed to write NFC tag');
    } finally {
      setNfcWriting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.label}>Purpose</Text>
      <View style={styles.row}>
        {PURPOSES.map((p) => (
          <Chip key={p.value} label={p.label} selected={purpose === p.value} onPress={() => setPurpose(p.value)} />
        ))}
      </View>

      <Text style={styles.label}>Credential type</Text>
      <View style={styles.row}>
        <Chip label="QR code" selected={credentialType === 'qr'} onPress={() => setCredentialType('qr')} />
        <Chip label="NFC tag" selected={credentialType === 'nfc'} onPress={() => setCredentialType('nfc')} />
      </View>

      <Field label="Owner type" placeholder="attendee, asset, member…" value={ownerType} onChangeText={setOwnerType} />
      <Field label="Owner reference" placeholder="member id, asset id…" value={ownerRef} onChangeText={setOwnerRef} />
      <Field label="Label (optional)" placeholder="Jane Doe — VIP" value={label} onChangeText={setLabel} />

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={[styles.button, busy && styles.buttonDisabled]} onPress={handleIssue} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Issue credential</Text>}
      </Pressable>

      {issued && (
        <View style={styles.result}>
          {issued.credentialType === 'qr' ? (
            <View style={styles.qrWrap}>
              <QRCode value={issued.token} size={200} />
              <View style={styles.resultBadge}>
                <QrCodeIcon size={14} color={colors.accent} />
                <Text style={styles.resultBadgeText}>Ready to scan</Text>
              </View>
            </View>
          ) : (
            <Pressable style={[styles.button, nfcWriting && styles.buttonDisabled]} onPress={handleWriteNfc} disabled={nfcWriting}>
              {nfcWriting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Wifi size={18} color="#fff" />
                  <Text style={styles.buttonText}>  Hold device near tag to write</Text>
                </>
              )}
            </Pressable>
          )}
          <Text style={styles.token}>{issued.token}</Text>
        </View>
      )}
    </ScrollView>
  );
}

function Field(props: React.ComponentProps<typeof TextInput> & { label: string }) {
  const { label, ...inputProps } = props;
  return (
    <View style={{ marginBottom: spacing(2) }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} placeholderTextColor={colors.textMuted} {...inputProps} />
    </View>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.chip, selected && styles.chipSelected]} onPress={onPress}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing(3), backgroundColor: colors.bg, flexGrow: 1 },
  label: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: spacing(0.75) },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(1), marginBottom: spacing(2) },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: spacing(1.75), paddingVertical: spacing(1), backgroundColor: colors.card },
  chipSelected: { borderColor: colors.accent, backgroundColor: '#ecfeff' },
  chipText: { fontSize: 13, color: colors.textSecondary, fontWeight: '600' },
  chipTextSelected: { color: colors.accent },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing(2),
    paddingVertical: spacing(1.5),
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.card,
  },
  button: {
    flexDirection: 'row',
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: spacing(1.75),
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing(1),
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  error: { color: colors.danger, fontSize: 13, marginBottom: spacing(2) },
  result: { alignItems: 'center', marginTop: spacing(3), padding: spacing(3), backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border },
  qrWrap: { alignItems: 'center', gap: spacing(1.5) },
  resultBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#ecfeff', paddingHorizontal: spacing(1.5), paddingVertical: spacing(0.5), borderRadius: 999 },
  resultBadgeText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  token: { fontSize: 11, color: colors.textMuted, marginTop: spacing(1.5), fontFamily: 'monospace' },
});

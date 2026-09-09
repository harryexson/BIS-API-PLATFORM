import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { colors, spacing } from '../theme';
import { useSession } from '../lib/SessionContext';

export default function SetupScreen() {
  const { signIn } = useSession();
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [tenantId, setTenantId] = useState('default');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleConnect = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) {
      setError('Gateway URL and API key are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // A lightweight reachability check before saving — better to fail here
      // than to silently store a bad URL and fail on every screen after.
      const res = await fetch(`${baseUrl.trim().replace(/\/$/, '')}/health`);
      if (!res.ok) throw new Error('Gateway did not respond to /health');
      await signIn({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), tenantId: tenantId.trim() || 'default' });
    } catch (err: any) {
      setError(`Could not reach gateway: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Connect to BIS API Platform</Text>
      <Text style={styles.subtitle}>
        Enter your application's gateway credentials. These are stored securely on this device only.
      </Text>

      <Field label="Gateway URL" placeholder="https://api.example.com" value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" keyboardType="url" />
      <Field label="API key" placeholder="bap_live_..." value={apiKey} onChangeText={setApiKey} autoCapitalize="none" secureTextEntry />
      <Field label="Tenant ID" placeholder="default" value={tenantId} onChangeText={setTenantId} autoCapitalize="none" />

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={[styles.button, busy && styles.buttonDisabled]} onPress={handleConnect} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Connect</Text>}
      </Pressable>
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

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: spacing(3), justifyContent: 'center', backgroundColor: colors.bg },
  title: { fontSize: 26, fontWeight: '800', color: colors.text, marginBottom: spacing(1) },
  subtitle: { fontSize: 14, color: colors.textSecondary, marginBottom: spacing(4) },
  label: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: spacing(0.5) },
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
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: spacing(1.75),
    alignItems: 'center',
    marginTop: spacing(2),
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  error: { color: colors.danger, fontSize: 13, marginBottom: spacing(2) },
});

import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Wifi, CheckCircle2, XCircle, Clock, HelpCircle } from 'lucide-react-native';
import { colors, spacing } from '../theme';
import { useSession } from '../lib/SessionContext';
import { gatewayApi } from '../api/client';
import { readTokenFromTag, isNfcSupported } from '../lib/nfc';
import type { VerifyScanResponse } from '../api/types';

type Mode = 'camera' | 'nfc';

const RESULT_META: Record<VerifyScanResponse['result'], { label: string; color: string; icon: typeof CheckCircle2 }> = {
  valid: { label: 'Valid', color: colors.success, icon: CheckCircle2 },
  expired: { label: 'Expired', color: colors.warning, icon: Clock },
  revoked: { label: 'Revoked', color: colors.danger, icon: XCircle },
  unknown: { label: 'Unknown token', color: colors.danger, icon: HelpCircle },
};

export default function ScanScreen() {
  const { session } = useSession();
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<Mode>('camera');
  const [nfcSupported, setNfcSupported] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [outcome, setOutcome] = useState<VerifyScanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    isNfcSupported().then(setNfcSupported);
  }, []);

  const verify = useCallback(
    async (token: string) => {
      if (!session) return;
      setVerifying(true);
      setError(null);
      try {
        const result = await gatewayApi.verifyCredential(session, token, 'mobile-app');
        setOutcome(result);
      } catch (err: any) {
        setError(err.message || 'Failed to verify credential');
      } finally {
        setVerifying(false);
        setScanning(false);
      }
    },
    [session],
  );

  const handleBarcodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (!scanning) return;
      setScanning(false);
      verify(data);
    },
    [scanning, verify],
  );

  const handleNfcRead = useCallback(async () => {
    setError(null);
    try {
      const token = await readTokenFromTag();
      if (!token) {
        setError('No readable credential found on that tag.');
        return;
      }
      await verify(token);
    } catch (err: any) {
      setError(err.message || 'Failed to read NFC tag');
    }
  }, [verify]);

  return (
    <View style={styles.container}>
      <View style={styles.modeRow}>
        <ModeButton label="Camera / QR" active={mode === 'camera'} onPress={() => setMode('camera')} />
        {nfcSupported && <ModeButton label="NFC tap" active={mode === 'nfc'} onPress={() => setMode('nfc')} />}
      </View>

      {mode === 'camera' && (
        <View style={styles.cameraWrap}>
          {!permission?.granted ? (
            <View style={styles.center}>
              <Text style={styles.permissionText}>Camera access is needed to scan QR codes.</Text>
              <Pressable style={styles.button} onPress={requestPermission}>
                <Text style={styles.buttonText}>Grant permission</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={scanning ? handleBarcodeScanned : undefined}
              />
              {!scanning && !verifying && (
                <Pressable style={styles.scanOverlayButton} onPress={() => { setOutcome(null); setScanning(true); }}>
                  <Text style={styles.buttonText}>Start scanning</Text>
                </Pressable>
              )}
              {scanning && <View style={styles.scanFrame} />}
            </>
          )}
        </View>
      )}

      {mode === 'nfc' && (
        <View style={styles.center}>
          <Pressable style={[styles.button, verifying && styles.buttonDisabled]} onPress={handleNfcRead} disabled={verifying}>
            <Wifi size={18} color="#fff" />
            <Text style={styles.buttonText}>  Hold device near tag</Text>
          </Pressable>
        </View>
      )}

      {verifying && (
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.permissionText}>Verifying…</Text>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {outcome && (
        <ResultCard outcome={outcome} onDismiss={() => setOutcome(null)} />
      )}
    </View>
  );
}

function ModeButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.modeButton, active && styles.modeButtonActive]} onPress={onPress}>
      <Text style={[styles.modeButtonText, active && styles.modeButtonTextActive]}>{label}</Text>
    </Pressable>
  );
}

function ResultCard({ outcome, onDismiss }: { outcome: VerifyScanResponse; onDismiss: () => void }) {
  const meta = RESULT_META[outcome.result];
  const Icon = meta.icon;
  return (
    <View style={[styles.resultCard, { borderColor: meta.color }]}>
      <Icon size={32} color={meta.color} />
      <Text style={[styles.resultLabel, { color: meta.color }]}>{meta.label}</Text>
      {outcome.credential && (
        <Text style={styles.resultDetail}>
          {outcome.credential.label || outcome.credential.ownerRef} · {outcome.credential.purpose}
        </Text>
      )}
      <Pressable onPress={onDismiss} style={styles.dismiss}>
        <Text style={styles.dismissText}>Scan another</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing(2) },
  modeRow: { flexDirection: 'row', gap: spacing(1), marginBottom: spacing(2) },
  modeButton: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: spacing(1.25), alignItems: 'center', backgroundColor: colors.card },
  modeButtonActive: { borderColor: colors.accent, backgroundColor: '#ecfeff' },
  modeButtonText: { fontWeight: '600', color: colors.textSecondary },
  modeButtonTextActive: { color: colors.accent },
  cameraWrap: { flex: 1, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000', minHeight: 320 },
  center: { alignItems: 'center', justifyContent: 'center', flex: 1, gap: spacing(1.5) },
  permissionText: { color: colors.textSecondary, fontSize: 14, textAlign: 'center' },
  scanFrame: {
    position: 'absolute',
    top: '30%',
    left: '20%',
    right: '20%',
    bottom: '30%',
    borderWidth: 3,
    borderColor: colors.accent,
    borderRadius: 16,
  },
  scanOverlayButton: {
    position: 'absolute',
    bottom: spacing(3),
    alignSelf: 'center',
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: spacing(3),
    paddingVertical: spacing(1.5),
  },
  button: {
    flexDirection: 'row',
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: spacing(1.75),
    paddingHorizontal: spacing(3),
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  error: { color: colors.danger, fontSize: 13, textAlign: 'center', marginTop: spacing(1) },
  resultCard: {
    alignItems: 'center',
    gap: spacing(0.5),
    marginTop: spacing(2),
    padding: spacing(3),
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 2,
  },
  resultLabel: { fontSize: 18, fontWeight: '800' },
  resultDetail: { fontSize: 13, color: colors.textSecondary },
  dismiss: { marginTop: spacing(1.5) },
  dismissText: { color: colors.accent, fontWeight: '600', fontSize: 14 },
});

import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { QrCode, ScanLine, LogOut } from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { colors, spacing } from '../theme';
import { useSession } from '../lib/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

export default function HomeScreen({ navigation }: Props) {
  const { session, signOut } = useSession();

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.eyebrow}>Connected as</Text>
      <Text style={styles.tenant}>{session?.tenantId}</Text>

      <ActionCard
        icon={<QrCode size={28} color={colors.accent} />}
        title="Issue a credential"
        body="Encode a new QR code or NFC tag for check-in, asset tracking, or membership."
        onPress={() => navigation.navigate('Issue')}
      />
      <ActionCard
        icon={<ScanLine size={28} color={colors.accent2} />}
        title="Scan / verify"
        body="Read a QR code or NFC tag and check whether it's valid, expired, or revoked."
        onPress={() => navigation.navigate('Scan')}
      />

      <Pressable style={styles.signOut} onPress={signOut}>
        <LogOut size={16} color={colors.textSecondary} />
        <Text style={styles.signOutText}>Disconnect from gateway</Text>
      </Pressable>
    </ScrollView>
  );
}

function ActionCard({ icon, title, body, onPress }: { icon: React.ReactNode; title: string; body: string; onPress: () => void }) {
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.cardIcon}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardBody}>{body}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing(3), backgroundColor: colors.bg, flexGrow: 1 },
  eyebrow: { fontSize: 12, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' },
  tenant: { fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: spacing(3) },
  card: {
    flexDirection: 'row',
    gap: spacing(2),
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing(2.5),
    marginBottom: spacing(2),
    alignItems: 'center',
  },
  cardIcon: { width: 48, height: 48, borderRadius: 12, backgroundColor: '#ecfeff', alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 4 },
  cardBody: { fontSize: 13, color: colors.textSecondary },
  signOut: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center', marginTop: spacing(3), padding: spacing(1) },
  signOutText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
});

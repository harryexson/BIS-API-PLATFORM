import React from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { CheckCircle2, LogOut } from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { colors, spacing } from '../theme';
import { useSession } from '../lib/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

export default function HomeScreen(_props: Props) {
  const { session, signOut } = useSession();

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.eyebrow}>Connected as</Text>
      <Text style={styles.tenant}>{session?.tenantId}</Text>

      <View style={styles.card}>
        <View style={styles.cardIcon}>
          <CheckCircle2 size={28} color={colors.success} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>Connected to gateway</Text>
          <Text style={styles.cardBody}>{session?.baseUrl}</Text>
        </View>
      </View>

      <Pressable style={styles.signOut} onPress={signOut}>
        <LogOut size={16} color={colors.textSecondary} />
        <Text style={styles.signOutText}>Disconnect from gateway</Text>
      </Pressable>
    </ScrollView>
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

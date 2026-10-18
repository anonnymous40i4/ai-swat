import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { env } from '@/config/env';
import { useAgentSession } from '@/state/AgentSessionContext';

export default function PrivacyScreen() {
  const { messages, pendingTelemetryCount, telemetryState, lastSyncAt, syncTelemetry, clearLocalData } = useAgentSession();

  const confirmClear = () => {
    Alert.alert('Usunąć dane lokalne?', 'Transkrypty i niesynchronizowane paczki znikną z tego telefonu.', [
      { text: 'Anuluj', style: 'cancel' },
      { text: 'Usuń', style: 'destructive', onPress: () => void clearLocalData() },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Prywatność</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Na tym telefonie</Text>
          <Row label="Wiadomości czatu" value={String(messages.length)} />
          <Row label="Retencja szkieletu" value="14 dni / 300" />
          <Row label="Magazyn" value="AsyncStorage (prod.: SQLCipher)" />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Wychodzi do Supabase</Text>
          <Text style={styles.body}>
            Maks. 10 rekordów liczbowych na zamkniętą sesję: cecha, wynik -1..1, pewność, kod uzasadnienia i
            hash wiadomości. Bez treści rozmów, audio i pamięci agenta. Każda paczka przechodzi egress firewall.
          </Text>
          <Row label="Oczekujące paczki" value={String(pendingTelemetryCount)} />
          <Row label="Stan synchronizacji" value={telemetryState} />
          <Row label="Ostatnia synchronizacja" value={lastSyncAt ? new Date(lastSyncAt).toLocaleString('pl-PL') : '—'} />
          <Row label="Backend" value={env.isSupabaseConfigured ? 'Supabase skonfigurowany' : 'DEMO lokalne'} />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Do Abacus.ai</Text>
          <Text style={styles.body}>
            Telefon nie kontaktuje się z Abacus. Supabase wysyła Master Agentowi wyłącznie pseudonimowy `swarm_uid` i —
            po osobnym, podpisanym żądaniu — liczby wektora wraz z kandydatami. Nazwiska i transkrypty nie istnieją
            w tej warstwie.
          </Text>
        </View>

        <Pressable style={styles.primary} onPress={() => void syncTelemetry()}>
          <Text style={styles.primaryText}>Synchronizuj paczki teraz</Text>
        </Pressable>
        <Pressable style={styles.danger} onPress={confirmClear}>
          <Text style={styles.dangerText}>Usuń dane lokalne</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F8F8FC' },
  content: { padding: 16, gap: 14, paddingBottom: 30 },
  title: { fontSize: 30, fontWeight: '900', color: '#191922' },
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 17, gap: 8 },
  cardTitle: { fontSize: 18, fontWeight: '800', color: '#241D57' },
  body: { color: '#4d4d5c', lineHeight: 21 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 14, paddingVertical: 5 },
  rowLabel: { color: '#626272', flex: 1 },
  rowValue: { color: '#191922', fontWeight: '700', textAlign: 'right', flex: 1 },
  primary: { backgroundColor: '#5B4DBC', borderRadius: 15, paddingVertical: 13, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '800' },
  danger: { backgroundColor: '#FDECEC', borderRadius: 15, paddingVertical: 13, alignItems: 'center' },
  dangerText: { color: '#A51D2D', fontWeight: '800' },
});

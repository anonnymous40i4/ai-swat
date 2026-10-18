import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { env } from '@/config/env';
import { supabase } from '@/lib/supabase';
import { useAgentSession } from '@/state/AgentSessionContext';
import { useAuth } from '@/state/AuthContext';

type PreferenceRow = { trait_key: string; category: string; score: number; is_hard_point: boolean };

export default function ProfileScreen() {
  const { userId, session, isDemo, signOut } = useAuth();
  const { fsmState, messages } = useAgentSession();
  const [posStatus, setPosStatus] = useState<string>('tryb demonstracyjny');
  const [preferences, setPreferences] = useState<PreferenceRow[]>([]);
  const [accountStatus, setAccountStatus] = useState<string>('profiling');

  const refresh = useCallback(async () => {
    if (!userId || !env.isSupabaseConfigured) return;
    const [pos, prefs, account] = await Promise.all([
      supabase.rpc('fn_my_pos_status'),
      supabase.rpc('fn_my_preference_summary'),
      supabase.from('app_users').select('status').eq('id', userId).maybeSingle(),
    ]);
    const posRow = Array.isArray(pos.data) ? pos.data[0] : null;
    if (posRow?.pos_status) setPosStatus(String(posRow.pos_status));
    if (Array.isArray(prefs.data)) setPreferences(prefs.data as PreferenceRow[]);
    if (account.data?.status) setAccountStatus(String(account.data.status));
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      void refresh().catch(() => undefined);
    }, [refresh]),
  );

  const togglePause = async () => {
    if (!env.isSupabaseConfigured) {
      setAccountStatus((value) => (value === 'paused' ? 'profiling' : 'paused'));
      return;
    }
    const { data, error } = await supabase.rpc('fn_set_my_pause', {
      p_paused: accountStatus !== 'paused',
    });
    if (!error && data) setAccountStatus(String(data));
  };

  const logout = async () => {
    await signOut();
    router.replace('/sign-in');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Profil</Text>
        <View style={styles.card}>
          <Row label="Konto" value={isDemo ? 'DEMO' : session?.user.email ?? '—'} />
          <Row label="Etap rozmów" value={fsmState} />
          <Row label="Wiadomości lokalne" value={String(messages.length)} />
          <Row label="Proof of Safety" value={posStatus} />
          <Row label="Status w roju" value={accountStatus} />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Twoje podsumowanie preferencji</Text>
          {preferences.length === 0 ? (
            <Text style={styles.body}>
              Brak zsynchronizowanych hard-pointów. Użytkownik widzi tylko preferencje; bramki bezpieczeństwa nie są
              zwracane do aplikacji.
            </Text>
          ) : (
            preferences.slice(0, 12).map((row) => (
              <Row key={row.trait_key} label={row.trait_key} value={`${row.score.toFixed(2)}${row.is_hard_point ? ' ●' : ''}`} />
            ))
          )}
        </View>

        <Pressable style={styles.primary} onPress={() => void togglePause()}>
          <Text style={styles.primaryText}>{accountStatus === 'paused' ? 'Wznów profilowanie' : 'Wstrzymaj mój profil w roju'}</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={() => void logout()}>
          <Text style={styles.secondaryText}>Wyloguj</Text>
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
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 17, gap: 7 },
  cardTitle: { fontSize: 18, fontWeight: '800', color: '#241D57' },
  body: { color: '#4d4d5c', lineHeight: 21 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 14, paddingVertical: 5 },
  rowLabel: { color: '#626272', flex: 1 },
  rowValue: { color: '#191922', fontWeight: '700', textAlign: 'right', flex: 1 },
  primary: { backgroundColor: '#5B4DBC', borderRadius: 15, paddingVertical: 13, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '800' },
  secondary: { backgroundColor: '#ECECF1', borderRadius: 15, paddingVertical: 13, alignItems: 'center' },
  secondaryText: { color: '#30303c', fontWeight: '800' },
});

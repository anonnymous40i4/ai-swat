import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MatchCard } from '@/components/MatchCard';
import { env } from '@/config/env';
import {
  fetchMatches,
  markMatchNotificationsSeen,
  respondToMatch,
  type MatchRow,
} from '@/services/matchesApi';
import { useAuth } from '@/state/AuthContext';

const DEMO_COMPONENTS = { intent: 0.92, values: 0.88, communication: 0.9, lifestyle: 0.78 };

export default function MatchesScreen() {
  const { userId } = useAuth();
  const [Matches, setMatches] = useState<MatchRow[]>([]);
  const [demoStatus, setDemoStatus] = useState('proposed');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!env.isSupabaseConfigured) return;
    setLoading(true);
    setError(null);
    try {
      setMatches(await fetchMatches());
      if (userId) await markMatchNotificationsSeen(userId);
    } catch {
      setError('Nie udało się pobrać dopasowań z Supabase.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const respond = useCallback(
    async (match: MatchRow, accept: boolean) => {
      const nextStatus = await respondToMatch(match.id, accept);
      setMatches((rows) => rows.map((row) => (row.id === match.id ? { ...row, status: nextStatus } : row)));
    },
    [],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
        contentContainerStyle={styles.content}
      >
        <Text style={styles.title}>Dopasowania</Text>
        <Text style={styles.sub}>
          Pojawiają się dopiero po decyzji Master Agenta. Brak wyniku oznacza, że żaden kandydat nie przekroczył progu.
        </Text>

        {loading && <ActivityIndicator color="#5B4DBC" style={styles.loader} />}
        {error && <Text style={styles.error}>{error}</Text>}

        {!env.isSupabaseConfigured ? (
          <MatchCard
            displayScore={95}
            componentScores={DEMO_COMPONENTS}
            status={demoStatus}
            isDemo
            onRespond={async (accept) => setDemoStatus(accept ? 'accepted_a' : 'declined')}
          />
        ) : Matches.length === 0 && !loading ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Brak dopasowań</Text>
            <Text style={styles.sub}>Wróć do rozmowy z agentem. Powiadomimy Cię pushem, gdy rój znajdzie kandydata.</Text>
          </View>
        ) : (
          Matches.map((match) => (
            <MatchCard
              key={match.id}
              displayScore={match.display_score}
              componentScores={match.component_scores}
              status={match.status}
              onRespond={(accept) => respond(match, accept)}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F8F8FC' },
  content: { paddingBottom: 28 },
  title: { fontSize: 30, fontWeight: '900', color: '#191922', paddingHorizontal: 16, paddingTop: 14 },
  sub: { color: '#626272', lineHeight: 21, paddingHorizontal: 16, marginTop: 6 },
  loader: { marginTop: 18 },
  error: { color: '#A51D2D', paddingHorizontal: 16, marginTop: 14 },
  empty: { margin: 16, backgroundColor: '#fff', borderRadius: 20, padding: 20 },
  emptyTitle: { fontSize: 19, fontWeight: '800', color: '#191922' },
});

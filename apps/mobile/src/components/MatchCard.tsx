import { Pressable, StyleSheet, Text, View } from 'react-native';

const LABELS: Record<string, string> = {
  intent: 'Zamiary',
  values: 'Wartości',
  communication: 'Komunikacja',
  lifestyle: 'Styl życia',
};

function componentPercent(rawCosine: number): number {
  return Math.max(0, Math.min(100, Math.round(((rawCosine + 1) / 2) * 100)));
}

export function MatchCard({
  displayScore,
  componentScores,
  status,
  isDemo = false,
  onRespond,
}: {
  displayScore: number;
  componentScores: Record<string, number>;
  status: string;
  isDemo?: boolean;
  onRespond?: (accept: boolean) => Promise<void>;
}) {
  const actionable = ['proposed', 'accepted_a', 'accepted_b'].includes(status);
  return (
    <View style={styles.card}>
      <View style={styles.topRow}>
        <View>
          <Text style={styles.title}>{isDemo ? 'DEMO: kandydat' : 'Znalazłem kandydata'}</Text>
          <Text style={styles.subtitle}>Dopasowanie intencji i wartości powyżej progu roju</Text>
        </View>
        <View style={styles.scoreBadge}>
          <Text style={styles.score}>{displayScore}%</Text>
        </View>
      </View>

      {Object.entries(componentScores).map(([key, value]) => {
        const percent = componentPercent(value);
        return (
          <View key={key} style={styles.barRow}>
            <Text style={styles.barLabel}>{LABELS[key] ?? key}</Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${percent}%` }]} />
            </View>
            <Text style={styles.barValue}>{percent}</Text>
          </View>
        );
      })}

      <Text style={styles.status}>Status: {status}. Tożsamość pozostaje ukryta do obustronnej akceptacji.</Text>

      {actionable && onRespond ? (
        <View style={styles.actions}>
          <Pressable style={[styles.button, styles.decline]} onPress={() => void onRespond(false)}>
            <Text style={styles.declineText}>Odrzuć</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.accept]} onPress={() => void onRespond(true)}>
            <Text style={styles.acceptText}>Akceptuj etap 1</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 22,
    padding: 18,
    margin: 14,
    borderWidth: 1,
    borderColor: '#E3E0F5',
    shadowColor: '#241d57',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  title: { fontSize: 20, fontWeight: '800', color: '#191922' },
  subtitle: { color: '#686878', marginTop: 4, maxWidth: 240 },
  scoreBadge: {
    minWidth: 76,
    borderRadius: 18,
    backgroundColor: '#5B4DBC',
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  score: { color: '#fff', fontSize: 24, fontWeight: '900' },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 13 },
  barLabel: { width: 104, color: '#30303c', fontWeight: '600' },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: '#E9E7F5', overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: '#5B4DBC', borderRadius: 4 },
  barValue: { width: 28, textAlign: 'right', color: '#686878' },
  status: { color: '#686878', marginTop: 14, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  button: { flex: 1, borderRadius: 14, paddingVertical: 12, alignItems: 'center' },
  accept: { backgroundColor: '#5B4DBC' },
  decline: { backgroundColor: '#F0F0F5' },
  acceptText: { color: '#fff', fontWeight: '800' },
  declineText: { color: '#30303c', fontWeight: '700' },
});

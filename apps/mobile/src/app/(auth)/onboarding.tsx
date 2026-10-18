import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/state/AuthContext';

export default function OnboardingScreen() {
  const { markConsentDone } = useAuth();
  const [specialCategoryPools, setSpecialCategoryPools] = useState(false);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      await markConsentDone({ specialCategoryPools });
      router.replace('/chat');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Zanim zaczniemy</Text>
        <Text style={styles.body}>
          Rozmawiasz wyłącznie ze swoim osobistym agentem na tym urządzeniu. Agent poznaje Twoje zamiary, wartości,
          sposób komunikacji oraz podejście do granic i bezpieczeństwa. Czasem opowie hipotetyczną historię i zapyta
          o zdanie.
        </Text>
        <View style={styles.box}>
          <Text style={styles.boxTitle}>Telefon</Text>
          <Text style={styles.body}>Treść rozmów, audio i pamięć agenta. Możesz usunąć je w każdej chwili.</Text>
          <Text style={styles.boxTitle}>Rój</Text>
          <Text style={styles.body}>Pseudonimowy wektor 32 liczb, status Proof of Safety, gruby region i wybrane ograniczenia.</Text>
        </View>

        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.switchTitle}>Pule dopasowań wymagające szczególnej zgody</Text>
            <Text style={styles.body}>Opcjonalnie. Bez tego nie zapisujemy kodów puli poszukiwań.</Text>
          </View>
          <Switch value={specialCategoryPools} onValueChange={setSpecialCategoryPools} />
        </View>

        <Pressable style={styles.primary} disabled={busy} onPress={() => void start()}>
          <Text style={styles.primaryText}>Rozumiem — zacznij rozmowę</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 22, gap: 14 },
  title: { fontSize: 30, fontWeight: '900', color: '#191922' },
  body: { color: '#4d4d5c', fontSize: 16, lineHeight: 23 },
  box: { backgroundColor: '#F4F2FF', borderRadius: 18, padding: 16, gap: 6 },
  boxTitle: { fontWeight: '800', color: '#33267E', marginTop: 6 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  switchText: { flex: 1, gap: 4 },
  switchTitle: { fontWeight: '800', color: '#191922' },
  primary: { backgroundColor: '#5B4DBC', borderRadius: 16, paddingVertical: 14, alignItems: 'center', marginTop: 10 },
  primaryText: { color: '#fff', fontWeight: '800' },
});

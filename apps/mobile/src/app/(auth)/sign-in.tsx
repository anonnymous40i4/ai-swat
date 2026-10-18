import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { env } from '@/config/env';
import { useAuth } from '@/state/AuthContext';

export default function SignInScreen() {
  const { signIn, signUp, enterDemo } = useAuth();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!env.isSupabaseConfigured) return;
    setBusy(true);
    try {
      if (mode === 'sign-in') await signIn(email, password);
      else await signUp(email, password);
      router.replace('/');
    } catch {
      Alert.alert('Nie udało się', mode === 'sign-in' ? 'Sprawdź e-mail i hasło.' : 'Rejestracja nie powiodła się.');
    } finally {
      setBusy(false);
    }
  };

  const demo = () => {
    enterDemo();
    router.replace('/onboarding');
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.card}>
        <Text style={styles.logo}>AI Swarm-Match</Text>
        <Text style={styles.sub}>Rozmowy zostają na telefonie. Rój widzi tylko wektor liczbowy i status PoS.</Text>

        {env.isSupabaseConfigured ? (
          <>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="E-mail"
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
            />
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="Hasło"
              secureTextEntry
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            />
            <Pressable style={styles.primary} disabled={busy} onPress={() => void submit()}>
              <Text style={styles.primaryText}>{mode === 'sign-in' ? 'Zaloguj się' : 'Utwórz konto'}</Text>
            </Pressable>
            <Pressable onPress={() => setMode((m) => (m === 'sign-in' ? 'sign-up' : 'sign-in'))}>
              <Text style={styles.link}>{mode === 'sign-in' ? 'Nie masz konta? Zarejestruj się' : 'Masz konto? Zaloguj się'}</Text>
            </Pressable>
          </>
        ) : (
          <Text style={styles.demoInfo}>Brak konfiguracji Supabase w `.env`: działa wyłącznie lokalny tryb DEMO.</Text>
        )}

        <Pressable style={styles.secondary} onPress={demo}>
          <Text style={styles.secondaryText}>Otwórz DEMO lokalne</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F6F5FB', justifyContent: 'center' },
  card: { margin: 20, backgroundColor: '#fff', borderRadius: 24, padding: 22, gap: 12 },
  logo: { fontSize: 30, fontWeight: '900', color: '#241D57' },
  sub: { color: '#5d5d6c', lineHeight: 21 },
  input: { backgroundColor: '#F1F1F6', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  primary: { backgroundColor: '#5B4DBC', borderRadius: 14, paddingVertical: 13, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '800' },
  link: { color: '#5B4DBC', fontWeight: '700', textAlign: 'center', paddingVertical: 4 },
  demoInfo: { color: '#6b5420', backgroundColor: '#FFF3CF', borderRadius: 12, padding: 12, lineHeight: 20 },
  secondary: { backgroundColor: '#ECEAF8', borderRadius: 14, paddingVertical: 13, alignItems: 'center', marginTop: 6 },
  secondaryText: { color: '#33267E', fontWeight: '800' },
});

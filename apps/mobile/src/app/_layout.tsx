import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { MatchRealtimeGate } from '@/components/MatchRealtimeGate';
import { TelemetrySyncGate } from '@/components/TelemetrySyncGate';
import { AgentSessionProvider } from '@/state/AgentSessionContext';
import { AuthProvider } from '@/state/AuthContext';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <AgentSessionProvider>
          <StatusBar style="dark" />
          <TelemetrySyncGate />
          <MatchRealtimeGate />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(tabs)" />
          </Stack>
        </AgentSessionProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

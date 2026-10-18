import { Redirect, Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';

import { useAuth } from '@/state/AuthContext';

function icon(symbol: string) {
  return function TabIcon({ color }: { color: ColorValue }) {
    return <Text style={{ color: color ?? '#5B4DBC', fontSize: 20 }}>{symbol}</Text>;
  };
}

export default function TabsLayout() {
  const { userId, isDemo, consentDone, isLoading } = useAuth();
  if (!isLoading && !userId && !isDemo) return <Redirect href="/sign-in" />;
  if (!isLoading && !consentDone) return <Redirect href="/onboarding" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#5B4DBC',
        tabBarInactiveTintColor: '#8a8a98',
      }}
    >
      <Tabs.Screen name="chat" options={{ title: 'Agent', tabBarIcon: icon('💬') }} />
      <Tabs.Screen name="matches" options={{ title: 'Dopasowania', tabBarIcon: icon('◎') }} />
      <Tabs.Screen name="privacy" options={{ title: 'Prywatność', tabBarIcon: icon('⬡') }} />
      <Tabs.Screen name="profile" options={{ title: 'Profil', tabBarIcon: icon('◐') }} />
    </Tabs>
  );
}

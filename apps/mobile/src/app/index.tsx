import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useAuth } from '@/state/AuthContext';

export default function IndexRoute() {
  const { userId, isDemo, isLoading, consentDone } = useAuth();

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#5B4DBC" />
      </View>
    );
  }
  if (!userId && !isDemo) return <Redirect href="/sign-in" />;
  if (!consentDone) return <Redirect href="/onboarding" />;
  return <Redirect href="/chat" />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
});

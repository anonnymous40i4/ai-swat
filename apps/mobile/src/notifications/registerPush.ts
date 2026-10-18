import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { env } from '@/config/env';
import { supabase } from '@/lib/supabase';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Rejestracja tokenu Expo Push -> public.push_devices (RLS: własny wiersz).
 * Wymaga fizycznego urządzenia i development/production builda (Android: nie Expo Go).
 */
export async function registerPushDevice(userId: string): Promise<string | null> {
  if (!env.isSupabaseConfigured || Platform.OS === 'web' || !Device.isDevice) return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('Matches', {
      name: 'Dopasowania',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 180, 120, 180],
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== 'granted') return null;

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return null;

  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'unknown';

  const { error } = await supabase.from('push_devices').upsert(
    {
      user_id: userId,
      expo_push_token: token,
      platform,
      notifications_enabled: true,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'expo_push_token' },
  );
  if (error) return null;
  return token;
}

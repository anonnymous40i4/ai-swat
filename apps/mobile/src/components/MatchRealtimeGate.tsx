import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert, AppState } from 'react-native';

import { env } from '@/config/env';
import { supabase } from '@/lib/supabase';
import { registerPushDevice } from '@/notifications/registerPush';
import { fetchUnseenMatchNotifications } from '@/services/matchesApi';
import { useAuth } from '@/state/AuthContext';

/**
 * Kanały powrotu wyniku Mastera na telefon (telefon nie wystawia webhooka):
 * 1) push APNs/FCM przez Expo Push Service — aplikacja w tle/zamknięta,
 * 2) Supabase Realtime na match_notifications — aplikacja aktywna,
 * 3) polling rezerwowy co 60 s wyłącznie w stanie active.
 */
export function MatchRealtimeGate() {
  const { userId } = useAuth();
  const knownIdsRef = useRef<Set<number>>(new Set());
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!userId || !env.isSupabaseConfigured) return;

    void registerPushDevice(userId).catch(() => undefined);

    const announce = (matchId: string) => {
      Alert.alert('Znalazłem kandydata', 'Master Agent znalazł dopasowanie powyżej progu zgodności.', [
        { text: 'Później', style: 'cancel' },
        { text: 'Zobacz', onPress: () => router.push('/matches') },
      ]);
      void matchId;
    };

    const poll = async () => {
      try {
        const rows = await fetchUnseenMatchNotifications(userId);
        for (const row of rows) {
          if (!knownIdsRef.current.has(row.id)) {
            knownIdsRef.current.add(row.id);
            if (initializedRef.current) announce(row.match_id);
          }
        }
        initializedRef.current = true;
      } catch {
        // Kolejny cykl Realtime/pollingu ponowi próbę; brak logowania treści.
      }
    };

    void poll();
    const interval = setInterval(() => {
      if (AppState.currentState === 'active') void poll();
    }, 60_000);

    const channel = supabase
      .channel(`match-notifications:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'match_notifications',
          filter: `recipient_user_id=eq.${userId}`,
        },
        () => {
          void poll();
        },
      )
      .subscribe();

    const responseListener = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      if (data?.type === 'MATCH_PROPOSED') router.push('/matches');
    });

    return () => {
      clearInterval(interval);
      responseListener.remove();
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  return null;
}

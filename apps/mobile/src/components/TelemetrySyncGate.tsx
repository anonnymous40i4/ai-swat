import NetInfo from '@react-native-community/netinfo';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { useAgentSession } from '@/state/AgentSessionContext';

/**
 * Komponent bez UI: po zamknięciu sesji paczka evidence czeka w lokalnym outboxie,
 * a ten gate wysyła ją wyłącznie przy aktywnej aplikacji i dostępnej sieci.
 * Status i liczbę oczekujących paczek użytkownik widzi na ekranie Prywatność.
 */
export function TelemetrySyncGate() {
  const { pendingTelemetryCount, syncTelemetry } = useAgentSession();
  const lastAttemptRef = useRef(0);

  useEffect(() => {
    const maybeSync = () => {
      const now = Date.now();
      if (pendingTelemetryCount <= 0 || now - lastAttemptRef.current < 15_000) return;
      lastAttemptRef.current = now;
      void syncTelemetry().catch(() => undefined);
    };

    maybeSync();
    const unsubscribeNet = NetInfo.addEventListener((state) => {
      if (state.isConnected) maybeSync();
    });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') maybeSync();
    });
    const interval = setInterval(maybeSync, 60_000);

    return () => {
      unsubscribeNet();
      subscription.remove();
      clearInterval(interval);
    };
  }, [pendingTelemetryCount, syncTelemetry]);

  return null;
}

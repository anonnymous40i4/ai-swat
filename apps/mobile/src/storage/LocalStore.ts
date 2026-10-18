import AsyncStorage from '@react-native-async-storage/async-storage';

import type { LocalChatMessage, TelemetryOutboxItem } from '@/contracts/evidence';

/**
 * SZKIELET magazynu lokalnego.
 * Produkcja: podmienić implementację na SQLCipher (transkrypty + memory_slota)
 * z kluczem w Secure Enclave/Keystore. Interfejs celowo wąski, żeby wymiana
 * nie dotykała ekranów ani silnika sesji.
 *
 * Reguły: transkrypty maks. 14 dni i 300 wiadomości na właściciela.
 */
const PREFIX = 'ai-swat.local.v1';
const MAX_MESSAGES = 300;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function key(ownerKey: string, kind: string): string {
  return `${PREFIX}.${kind}.${ownerKey}`;
}

async function readJson<T>(storageKey: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const LocalStore = {
  async loadMessages(ownerKey: string): Promise<LocalChatMessage[]> {
    const rows = await readJson<LocalChatMessage[]>(key(ownerKey, 'messages'), []);
    const cutoff = Date.now() - MAX_AGE_MS;
    return rows
      .filter((m) => Number.isFinite(Date.parse(m.createdAt)) && Date.parse(m.createdAt) >= cutoff)
      .slice(-MAX_MESSAGES);
  },

  async saveMessages(ownerKey: string, messages: LocalChatMessage[]): Promise<void> {
    await AsyncStorage.setItem(key(ownerKey, 'messages'), JSON.stringify(messages.slice(-MAX_MESSAGES)));
  },

  async loadOutbox(ownerKey: string): Promise<TelemetryOutboxItem[]> {
    return readJson<TelemetryOutboxItem[]>(key(ownerKey, 'telemetry-outbox'), []);
  },

  async saveOutbox(ownerKey: string, items: TelemetryOutboxItem[]): Promise<void> {
    await AsyncStorage.setItem(key(ownerKey, 'telemetry-outbox'), JSON.stringify(items.slice(-20)));
  },

  async loadSessionMeta(ownerKey: string): Promise<{ sessionId?: string; fsmState?: string; lastSyncAt?: string; evaluatedThroughId?: string }> {
    return readJson(key(ownerKey, 'session-meta'), {});
  },

  async saveSessionMeta(ownerKey: string, meta: { sessionId?: string; fsmState?: string; lastSyncAt?: string; evaluatedThroughId?: string }): Promise<void> {
    await AsyncStorage.setItem(key(ownerKey, 'session-meta'), JSON.stringify(meta));
  },

  async loadConsentDone(ownerKey: string): Promise<boolean> {
    return (await AsyncStorage.getItem(key(ownerKey, 'consent-done'))) === '1';
  },

  async saveConsentDone(ownerKey: string): Promise<void> {
    await AsyncStorage.setItem(key(ownerKey, 'consent-done'), '1');
  },

  async clearOwner(ownerKey: string): Promise<void> {
    await AsyncStorage.removeMany([
      key(ownerKey, 'messages'),
      key(ownerKey, 'telemetry-outbox'),
      key(ownerKey, 'session-meta'),
    ]);
  },
};

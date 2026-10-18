import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { env } from '@/config/env';
import { newUuid } from '@/lib/id';

const KEY_ID_STORAGE = 'ai-swat.device-key-id.v1';

/**
 * Identyfikacja klucza urządzenia. Stan obecny (szkielet):
 * - key_id jest generowane lokalnie i trzymane w SecureStore (web: fallback AsyncStorage),
 * - podpis produkcyjny Ed25519 podepniesz w sign() po dodaniu natywnego modułu
 *   (klucz prywatny wyłącznie w SecureStore/Keystore, publiczny rejestrowany
 *   w public.device_keys i aktywowany serwerowo po atestacji),
 * - tryb dev zwraca jawny marker 'dev-unsigned' — serwer przyjmie go tylko przy
 *   ALLOW_UNSIGNED_EVIDENCE=true.
 */
export const DeviceSigner = {
  async getOrCreateKeyId(): Promise<string> {
    if (Platform.OS !== 'web') {
      const existing = await SecureStore.getItemAsync(KEY_ID_STORAGE);
      if (existing) return existing;
      const created = newUuid();
      await SecureStore.setItemAsync(KEY_ID_STORAGE, created);
      return created;
    }
    const existing = await AsyncStorage.getItem(KEY_ID_STORAGE);
    if (existing) return existing;
    const created = newUuid();
    await AsyncStorage.setItem(KEY_ID_STORAGE, created);
    return created;
  },

  async sign(_canonicalPayloadJson: string): Promise<{ keyId: string; signature: string }> {
    const keyId = await DeviceSigner.getOrCreateKeyId();
    if (env.allowUnsignedEvidence) return { keyId, signature: 'dev-unsigned' };
    throw new Error('PRODUCTION_DEVICE_SIGNER_NOT_LINKED');
  },
};

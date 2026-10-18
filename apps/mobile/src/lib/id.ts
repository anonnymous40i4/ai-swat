import * as Crypto from 'expo-crypto';

/** UUID v4 z kryptograficznego RNG urządzenia (bez zależności od globalnego crypto Hermes). */
export function newUuid(): string {
  const bytes = new Uint8Array(Crypto.getRandomBytes(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function sha256Prefixed(value: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
  return `sha256:${digest.toLowerCase()}`;
}

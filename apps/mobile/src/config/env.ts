const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const env = {
  supabaseUrl,
  supabaseAnonKey,
  /** Brak env = tryb DEMO w 100% lokalny (bez żadnego ruchu sieciowego do backendu). */
  isSupabaseConfigured:
    supabaseUrl.startsWith('https://') &&
    !supabaseUrl.includes('twoj-projekt') &&
    supabaseAnonKey.length > 20 &&
    supabaseAnonKey !== 'twoj-anon-key',
  localLlm: process.env.EXPO_PUBLIC_LOCAL_LLM ?? 'mock',
  allowUnsignedEvidence: process.env.EXPO_PUBLIC_ALLOW_UNSIGNED_EVIDENCE === 'true',
} as const;

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import 'react-native-url-polyfill/auto';

import { env } from '@/config/env';

/**
 * Klient użytkownika: wyłącznie anon key + JWT zalogowanego użytkownika.
 * Telefon NIGDY nie woła Abacus ani nie zna deploymentTokena/HMAC/service_role.
 */
export const supabase = createClient(
  env.isSupabaseConfigured ? env.supabaseUrl : 'https://placeholder.supabase.co',
  env.isSupabaseConfigured ? env.supabaseAnonKey : 'placeholder-anon-key',
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: Platform.OS === 'web',
    },
    realtime: { params: { eventsPerSecond: 2 } },
  },
);

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { requiredEnv } from "./http.ts";

/** Klient service_role: wyłącznie wewnątrz Edge Functions, nigdy w Abacus ani w aplikacji. */
export function supabaseAdmin(): SupabaseClient {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Klient z JWT użytkownika (walidacja tożsamości w ingest-evidence). */
export function supabaseAsUser(authorization: string): SupabaseClient {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

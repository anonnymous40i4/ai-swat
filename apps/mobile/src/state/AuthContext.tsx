import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';

import { env } from '@/config/env';
import { supabase } from '@/lib/supabase';
import { LocalStore } from '@/storage/LocalStore';

type AuthContextValue = {
  session: Session | null;
  userId: string | null;
  ownerKey: string;
  isDemo: boolean;
  isLoading: boolean;
  consentDone: boolean;
  enterDemo: () => void;
  markConsentDone: (scopes: { specialCategoryPools: boolean }) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function ensureAppUser(userId: string): Promise<void> {
  await supabase.from('app_users').upsert({ id: userId }, { onConflict: 'id', ignoreDuplicates: true });
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [isDemo, setIsDemo] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [consentDone, setConsentDone] = useState(false);

  const userId = session?.user.id ?? null;
  const ownerKey = userId ?? (isDemo ? 'demo' : 'anonymous');

  useEffect(() => {
    let mounted = true;
    if (!env.isSupabaseConfigured) {
      setIsLoading(false);
      return;
    }
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return;
        setSession(data.session);
        setIsLoading(false);
      })
      .catch(() => {
        if (mounted) setIsLoading(false);
      });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setIsLoading(false);
    });
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (userId && env.isSupabaseConfigured) void ensureAppUser(userId).catch(() => undefined);
  }, [userId]);

  useEffect(() => {
    let mounted = true;
    LocalStore.loadConsentDone(ownerKey)
      .then((done) => {
        if (mounted) setConsentDone(done);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [ownerKey]);

  const enterDemo = useCallback(() => setIsDemo(true), []);

  const markConsentDone = useCallback(
    async ({ specialCategoryPools }: { specialCategoryPools: boolean }) => {
      await LocalStore.saveConsentDone(ownerKey);
      setConsentDone(true);
      if (userId && env.isSupabaseConfigured) {
        const rows = [
          { user_id: userId, scope: 'profiling', granted: true, terms_version: 'terms-v1' },
          { user_id: userId, scope: 'matching', granted: true, terms_version: 'terms-v1' },
          ...(specialCategoryPools
            ? [{ user_id: userId, scope: 'special_category_matching_pools', granted: true, terms_version: 'terms-v1' }]
            : []),
        ];
        await supabase.from('consent_log').insert(rows);
      }
    },
    [ownerKey, userId],
  );

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw new Error('SIGN_IN_FAILED');
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email: email.trim(), password });
    if (error) throw new Error('SIGN_UP_FAILED');
  }, []);

  const signOut = useCallback(async () => {
    setIsDemo(false);
    if (env.isSupabaseConfigured) await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      userId,
      ownerKey,
      isDemo,
      isLoading,
      consentDone,
      enterDemo,
      markConsentDone,
      signIn,
      signUp,
      signOut,
    }),
    [session, userId, ownerKey, isDemo, isLoading, consentDone, enterDemo, markConsentDone, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth poza AuthProvider');
  return value;
}

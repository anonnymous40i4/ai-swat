import { env } from '@/config/env';
import { supabase } from '@/lib/supabase';

export type MatchRow = {
  id: string;
  raw_similarity: number;
  display_score: number;
  component_scores: Record<string, number>;
  status: string;
  created_at: string;
  expires_at: string;
};

export type MatchNotificationRow = {
  id: number;
  match_id: string;
  status: string;
  created_at: string;
  seen_at: string | null;
};

/** Telefon nie nasłuchuje webhooka — czyta wynik z Supabase chroniony RLS. */
export async function fetchMatches(): Promise<MatchRow[]> {
  if (!env.isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from('Matches')
    .select('id,raw_similarity,display_score,component_scores,status,created_at,expires_at')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error('MATCH_FETCH_FAILED');
  return (data ?? []) as MatchRow[];
}

export async function fetchUnseenMatchNotifications(userId: string): Promise<MatchNotificationRow[]> {
  if (!env.isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from('match_notifications')
    .select('id,match_id,status,created_at,seen_at')
    .eq('recipient_user_id', userId)
    .neq('status', 'seen')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error('NOTIFICATION_FETCH_FAILED');
  return (data ?? []) as MatchNotificationRow[];
}

export async function markMatchNotificationsSeen(userId: string): Promise<void> {
  if (!env.isSupabaseConfigured) return;
  await supabase
    .from('match_notifications')
    .update({ status: 'seen', seen_at: new Date().toISOString() })
    .eq('recipient_user_id', userId)
    .neq('status', 'seen');
}

export async function respondToMatch(matchId: string, accept: boolean): Promise<string> {
  const { data, error } = await supabase.rpc('fn_respond_to_match', {
    p_match_id: matchId,
    p_accept: accept,
  });
  if (error) throw new Error('MATCH_RESPOND_FAILED');
  return String(data);
}

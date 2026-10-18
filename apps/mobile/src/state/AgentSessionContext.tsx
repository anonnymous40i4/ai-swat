import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';

import { env } from '@/config/env';
import type { LocalChatMessage, TelemetryOutboxItem } from '@/contracts/evidence';
import type { FsmState } from '@/contracts/traits';
import { AgentSessionEngine } from '@/edge/AgentSessionEngine';
import { buildEvidencePayload } from '@/edge/EvidencePayloadBuilder';
import { LlamaRnNotLinkedAdapter } from '@/edge/LocalLlmAdapter';
import { MockLocalLlmAdapter } from '@/edge/MockLocalLlmAdapter';
import { newUuid } from '@/lib/id';
import { uploadEvidence } from '@/services/evidenceApi';
import { LocalStore } from '@/storage/LocalStore';
import { useAuth } from './AuthContext';

export type TelemetrySyncState = 'idle' | 'syncing' | 'local_only' | 'blocked' | 'error';

type AgentSessionValue = {
  messages: LocalChatMessage[];
  isGenerating: boolean;
  isClosingSession: boolean;
  fsmState: FsmState;
  pendingTelemetryCount: number;
  telemetryState: TelemetrySyncState;
  lastSyncAt: string | null;
  sendMessage: (text: string) => Promise<void>;
  closeSession: () => Promise<void>;
  syncTelemetry: () => Promise<void>;
  clearLocalData: () => Promise<void>;
};

const AgentSessionContext = createContext<AgentSessionValue | null>(null);

const engine = new AgentSessionEngine(
  env.localLlm === 'mock' ? new MockLocalLlmAdapter() : new LlamaRnNotLinkedAdapter(),
);

const BOOTSTRAP_MESSAGE: Omit<LocalChatMessage, 'id' | 'createdAt'> = {
  role: 'assistant',
  text: 'Cześć. Jestem Twoim osobistym agentem i działam na tym telefonie. Porozmawiajmy najpierw o tym, czego naprawdę szukasz — poważnego związku, czegoś niezobowiązującego czy jeszcze nie wiesz?',
};

function message(role: LocalChatMessage['role'], text: string): LocalChatMessage {
  return { id: newUuid(), role, text, createdAt: new Date().toISOString() };
}

export function AgentSessionProvider({ children }: PropsWithChildren) {
  const { ownerKey } = useAuth();
  const [messages, setMessagesState] = useState<LocalChatMessage[]>([]);
  const [fsmState, setFsmState] = useState<FsmState>('RAPPORT_VALUES');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isClosingSession, setIsClosingSession] = useState(false);
  const [telemetryState, setTelemetryState] = useState<TelemetrySyncState>('idle');
  const [pendingTelemetryCount, setPendingTelemetryCount] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const messagesRef = useRef<LocalChatMessage[]>([]);
  const sessionIdRef = useRef(newUuid());
  const evaluatedThroughRef = useRef<string | undefined>(undefined);
  const syncingRef = useRef(false);

  const persistMessages = useCallback(
    (next: LocalChatMessage[]) => {
      messagesRef.current = next;
      setMessagesState(next);
      void LocalStore.saveMessages(ownerKey, next).catch(() => undefined);
    },
    [ownerKey],
  );

  const persistMeta = useCallback(() => {
    void LocalStore.saveSessionMeta(ownerKey, {
      sessionId: sessionIdRef.current,
      fsmState,
      lastSyncAt: lastSyncAt ?? undefined,
      evaluatedThroughId: evaluatedThroughRef.current,
    }).catch(() => undefined);
  }, [fsmState, lastSyncAt, ownerKey]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [storedMessages, meta, outbox] = await Promise.all([
        LocalStore.loadMessages(ownerKey),
        LocalStore.loadSessionMeta(ownerKey),
        LocalStore.loadOutbox(ownerKey),
      ]);
      if (!mounted) return;
      sessionIdRef.current = meta.sessionId ?? newUuid();
      evaluatedThroughRef.current = meta.evaluatedThroughId;
      setFsmState((meta.fsmState as FsmState | undefined) ?? 'RAPPORT_VALUES');
      setLastSyncAt(meta.lastSyncAt ?? null);
      setPendingTelemetryCount(outbox.length);
      const initial = storedMessages.length > 0 ? storedMessages : [message(BOOTSTRAP_MESSAGE.role, BOOTSTRAP_MESSAGE.text)];
      messagesRef.current = initial;
      setMessagesState(initial);
      if (storedMessages.length === 0) void LocalStore.saveMessages(ownerKey, initial).catch(() => undefined);
    })().catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [ownerKey]);

  useEffect(() => {
    persistMeta();
  }, [persistMeta]);

  const sendMessage = useCallback(
    async (rawText: string) => {
      const text = rawText.trim().slice(0, 2000);
      if (!text || isGenerating) return;

      const userMessage = message('user', text);
      const withUser = [...messagesRef.current, userMessage];
      persistMessages(withUser);
      setIsGenerating(true);
      try {
        const reply = await engine.chat(withUser, fsmState);
        persistMessages([...messagesRef.current, message('assistant', reply)]);
      } catch {
        persistMessages([
          ...messagesRef.current,
          message('assistant', 'Lokalny model nie jest teraz dostępny na tym urządzeniu. Twoja wiadomość została zapisana wyłącznie lokalnie.'),
        ]);
      } finally {
        setIsGenerating(false);
      }
    },
    [fsmState, isGenerating, persistMessages],
  );

  const closeSession = useCallback(async () => {
    if (isClosingSession) return;
    const all = messagesRef.current;
    const startIndex = evaluatedThroughRef.current
      ? all.findIndex((m) => m.id === evaluatedThroughRef.current) + 1
      : 0;
    const transcript = all.slice(Math.max(0, startIndex));
    if (transcript.filter((m) => m.role === 'user').length < 3) return;

    setIsClosingSession(true);
    try {
      const output = await engine.evaluate(transcript, fsmState);
      if (output && (output.evidence.length > 0 || output.safetyFlags.length > 0)) {
        const payload = await buildEvidencePayload({
          sessionId: sessionIdRef.current,
          modelId: engine.modelId,
          promptVersion: engine.promptVersion,
          fsmState,
          transcript,
          output,
        });
        const outbox = await LocalStore.loadOutbox(ownerKey);
        if (!outbox.some((item) => item.payload.session_id === payload.session_id)) {
          const item: TelemetryOutboxItem = {
            id: newUuid(),
            payload,
            attempts: 0,
            nextAttemptAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          };
          const next = [...outbox, item].slice(-20);
          await LocalStore.saveOutbox(ownerKey, next);
          setPendingTelemetryCount(next.length);
        }
      }
      evaluatedThroughRef.current = all[all.length - 1]?.id;
      sessionIdRef.current = newUuid();
      if (output && output.nextFsmState !== 'READY_FOR_SWARM' && output.nextFsmState !== 'PAUSED') {
        setFsmState(output.nextFsmState);
      }
      persistMeta();
    } catch {
      setTelemetryState('error');
    } finally {
      setIsClosingSession(false);
    }
  }, [fsmState, isClosingSession, ownerKey, persistMeta]);

  const syncTelemetry = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setTelemetryState('syncing');
    try {
      const outbox = await LocalStore.loadOutbox(ownerKey);
      if (outbox.length === 0) {
        setTelemetryState(env.isSupabaseConfigured ? 'idle' : 'local_only');
        setPendingTelemetryCount(0);
        return;
      }
      if (!env.isSupabaseConfigured) {
        setTelemetryState('local_only');
        setPendingTelemetryCount(outbox.length);
        return;
      }

      const now = Date.now();
      const remaining: TelemetryOutboxItem[] = [];
      let uploaded = 0;
      let blocked = false;

      for (const item of outbox) {
        if (Date.parse(item.nextAttemptAt) > now) {
          remaining.push(item);
          continue;
        }
        const result = await uploadEvidence(item.payload);
        if (result.ok) {
          uploaded += 1;
          continue;
        }
        if (!result.retryable) blocked = true;
        const attempts = result.retryable ? item.attempts + 1 : item.attempts;
        if (attempts < 8) {
          remaining.push({
            ...item,
            attempts,
            lastErrorCode: result.errorCode,
            nextAttemptAt: new Date(now + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 6))).toISOString(),
          });
        }
      }

      await LocalStore.saveOutbox(ownerKey, remaining);
      setPendingTelemetryCount(remaining.length);
      if (uploaded > 0) {
        const syncedAt = new Date().toISOString();
        setLastSyncAt(syncedAt);
        await LocalStore.saveSessionMeta(ownerKey, {
          sessionId: sessionIdRef.current,
          fsmState,
          lastSyncAt: syncedAt,
          evaluatedThroughId: evaluatedThroughRef.current,
        });
      }
      setTelemetryState(blocked ? 'blocked' : remaining.length > 0 ? 'error' : 'idle');
    } catch {
      setTelemetryState('error');
    } finally {
      syncingRef.current = false;
    }
  }, [fsmState, ownerKey]);

  const clearLocalData = useCallback(async () => {
    await LocalStore.clearOwner(ownerKey);
    sessionIdRef.current = newUuid();
    evaluatedThroughRef.current = undefined;
    setPendingTelemetryCount(0);
    setLastSyncAt(null);
    const initial = [message(BOOTSTRAP_MESSAGE.role, BOOTSTRAP_MESSAGE.text)];
    messagesRef.current = initial;
    setMessagesState(initial);
    await LocalStore.saveMessages(ownerKey, initial);
  }, [ownerKey]);

  const value = useMemo<AgentSessionValue>(
    () => ({
      messages,
      isGenerating,
      isClosingSession,
      fsmState,
      pendingTelemetryCount,
      telemetryState,
      lastSyncAt,
      sendMessage,
      closeSession,
      syncTelemetry,
      clearLocalData,
    }),
    [messages, isGenerating, isClosingSession, fsmState, pendingTelemetryCount, telemetryState, lastSyncAt, sendMessage, closeSession, syncTelemetry, clearLocalData],
  );

  return <AgentSessionContext.Provider value={value}>{children}</AgentSessionContext.Provider>;
}

export function useAgentSession(): AgentSessionValue {
  const value = useContext(AgentSessionContext);
  if (!value) throw new Error('useAgentSession poza AgentSessionProvider');
  return value;
}

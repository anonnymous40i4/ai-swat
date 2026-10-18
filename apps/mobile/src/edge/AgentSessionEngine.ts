import type { EvaluatorOutput, LocalChatMessage } from '@/contracts/evidence';
import type { FsmState } from '@/contracts/traits';
import type { LocalLlmAdapter } from './LocalLlmAdapter';

/**
 * Budżet urządzenia (twarde limity, niezależne od adaptera):
 * - jedna inferencja naraz (łańcuch Promise),
 * - do modelu trafia maks. 12 ostatnich wiadomości / 6000 znaków,
 * - model rozładowuje się po 120 s bezczynności,
 * - ewaluator maks. raz na zamkniętą sesję i tylko przy >= 3 turach użytkownika.
 */
const MAX_CONTEXT_MESSAGES = 12;
const MAX_CONTEXT_CHARS = 6000;
const IDLE_UNLOAD_MS = 120_000;
const MIN_USER_TURNS_FOR_EVALUATION = 3;

function trimContext(transcript: LocalChatMessage[]): LocalChatMessage[] {
  const tail = transcript.slice(-MAX_CONTEXT_MESSAGES);
  const out: LocalChatMessage[] = [];
  let chars = 0;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    chars += tail[i].text.length;
    if (chars > MAX_CONTEXT_CHARS) break;
    out.unshift(tail[i]);
  }
  return out;
}

export class AgentSessionEngine {
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly adapter: LocalLlmAdapter) {}

  get modelId(): string {
    return this.adapter.modelId;
  }

  get promptVersion(): string {
    return this.adapter.promptVersion;
  }

  private scheduleIdleUnload(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.adapter.unload().catch(() => undefined);
    }, IDLE_UNLOAD_MS);
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async chat(transcript: LocalChatMessage[], fsmState: FsmState): Promise<string> {
    return this.exclusive(async () => {
      if (!this.adapter.isLoaded()) await this.adapter.load();
      try {
        return await this.adapter.chat(trimContext(transcript), fsmState);
      } finally {
        this.scheduleIdleUnload();
      }
    });
  }

  async evaluate(transcript: LocalChatMessage[], fsmState: FsmState): Promise<EvaluatorOutput | null> {
    const userTurns = transcript.filter((m) => m.role === 'user').length;
    if (userTurns < MIN_USER_TURNS_FOR_EVALUATION) return null;
    return this.exclusive(async () => {
      if (!this.adapter.isLoaded()) await this.adapter.load();
      try {
        return await this.adapter.evaluate(trimContext(transcript), fsmState);
      } finally {
        this.scheduleIdleUnload();
      }
    });
  }

  async unloadNow(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.exclusive(async () => {
      await this.adapter.unload();
    });
  }
}

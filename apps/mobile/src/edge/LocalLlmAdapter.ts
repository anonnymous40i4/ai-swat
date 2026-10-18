import type { EvaluatorOutput, LocalChatMessage } from '@/contracts/evidence';
import type { FsmState } from '@/contracts/traits';

/**
 * Jedyny interfejs modelu on-device. Produkcja podpina tu llama.rn
 * (LLaMA 3.1 8B Instruct Q4_K_M) w development buildzie EAS — Expo Go nie wystarczy.
 * Prompt systemowy: repo /prompts/personal_agent_llama_system_prompt.txt.
 */
export type LocalLlmAdapter = {
  readonly modelId: string;
  readonly promptVersion: string;
  load(): Promise<void>;
  unload(): Promise<void>;
  isLoaded(): boolean;
  chat(transcript: LocalChatMessage[], fsmState: FsmState): Promise<string>;
  evaluate(transcript: LocalChatMessage[], fsmState: FsmState): Promise<EvaluatorOutput>;
};

/** Placeholder produkcyjny: świadomie failuje bez natywnego modułu, zamiast udawać model. */
export class LlamaRnNotLinkedAdapter implements LocalLlmAdapter {
  readonly modelId = 'llama-3.1-8b-instruct-q4_k_m';
  readonly promptVersion = 'pers-agent-v1.0';

  async load(): Promise<void> {
    throw new Error('LLAMA_RN_NOT_LINKED: zbuduj EAS development build i podepnij llama.rn w tym adapterze.');
  }

  async unload(): Promise<void> {}

  isLoaded(): boolean {
    return false;
  }

  async chat(): Promise<string> {
    throw new Error('LLAMA_RN_NOT_LINKED');
  }

  async evaluate(): Promise<EvaluatorOutput> {
    throw new Error('LLAMA_RN_NOT_LINKED');
  }
}

import type { EvaluatorOutput, LocalChatMessage, RawTraitEvidence } from '@/contracts/evidence';
import type { LocalLlmAdapter } from './LocalLlmAdapter';

/**
 * Adapter DEMO do podglądu UI i testów przepływu. Nie jest modelem językowym.
 * Heurystyki ewaluatora mają celowo niską pewność (<=0.55), więc nie utworzą
 * hard-pointów. W produkcji zastępuje go adapter llama.rn z promptem z repo.
 */
export class MockLocalLlmAdapter implements LocalLlmAdapter {
  readonly modelId = 'mock-local-llm-dev';
  readonly promptVersion = 'pers-agent-v1.0';
  private loaded = false;

  async load(): Promise<void> {
    this.loaded = true;
  }

  async unload(): Promise<void> {
    this.loaded = false;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async chat(transcript: LocalChatMessage[]): Promise<string> {
    const userTurns = transcript.filter((m) => m.role === 'user').length;
    await new Promise((resolve) => setTimeout(resolve, 450));

    switch (userTurns) {
      case 0:
        return 'Cześć. Jestem Twoim osobistym agentem — działam na tym telefonie. Zanim kogokolwiek Ci zaproponuję, chcę zrozumieć, czego naprawdę szukasz. Poważny związek, coś niezobowiązującego, czy jeszcze nie wiesz?';
      case 1:
        return 'Dzięki za szczerość. To teraz historia z życia znajomych: kumpel na randce, młody kelner wylewa mu drinka na koszulę. Kumpel wstaje i przy całej sali nazywa go pajacem, mimo potoku przeprosin. Przesadził czy „postawił granice”?';
      case 2:
        return 'A Ty na jego miejscu — mokra koszula, randka obok? Co robisz, tak bez wersji pod publikę?';
      case 3:
        return 'Rozumiem. Inny znajomy ma „strategię”: mówi, że szuka czegoś poważnego, choć chodzi mu głównie o przygodę, bo po prawdzie „nic by z tego nie było”. Skuteczne czy coś tu nie gra?';
      case 4:
        return 'A gdyby ktoś powiedział Ci wprost „dziś nie chcę iść dalej”, to temat zamknięty, czy jest jeszcze pole do rozmowy?';
      default:
        return 'Notuję to sobie lokalnie. Opowiedz mi jeszcze, jak wygląda Twój normalny tydzień — więcej ludzi i wyjść czy raczej dom i spokój? Gdy skończymy na dziś, kliknij „Zakończ sesję” u góry.';
    }
  }

  async evaluate(transcript: LocalChatMessage[]): Promise<EvaluatorOutput> {
    const userMessages = transcript.filter((m) => m.role === 'user');
    const evidence: RawTraitEvidence[] = [];

    const drinkAnswer = userMessages[1];
    if (drinkAnswer && /przesadz|nie powinien|tonowa|spokojnie|przeprosił|krzyk nie/i.test(drinkAnswer.text)) {
      evidence.push({
        probeId: 'SJT-AGG-01',
        traitKey: 'safety_non_aggression',
        score: 0.6,
        confidence: 0.5,
        evidenceClass: 'sjt_response',
        rationaleCode: 'DEESCALATION_EXPLICIT',
        sourceMessageId: drinkAnswer.id,
      });
    }

    const strategyAnswer = userMessages[3];
    if (strategyAnswer && /nie gra|manipul|okłam|ściem|uczciw|nie fair/i.test(strategyAnswer.text)) {
      evidence.push({
        probeId: 'SJT-CONS-01',
        traitKey: 'honesty_transparency',
        score: 0.6,
        confidence: 0.5,
        evidenceClass: 'sjt_response',
        rationaleCode: 'INTENT_LYING_REJECTED',
        sourceMessageId: strategyAnswer.id,
      });
    }

    return { evidence, safetyFlags: [], nextFsmState: 'CONSISTENCY' };
  }
}

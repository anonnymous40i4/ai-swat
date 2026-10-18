import type { EvaluatorOutput, LocalChatMessage, TraitEvidencePayload } from '@/contracts/evidence';
import type { FsmState } from '@/contracts/traits';
import { sha256Prefixed } from '@/lib/id';
import { assertEvidencePayload, MAX_EVIDENCE_PER_SESSION } from './EgressFirewall';

/**
 * Zamienia wynik ewaluatora na paczkę sieciową:
 * - maks. 10 najpewniejszych trait-evidence na sesję (limit z KROKU D);
 *   agregacja do pełnego 32-wektora dzieje się serwerowo z wielu sesji,
 * - tekst wiadomości jest zamieniany na SHA-256 i NIGDY nie trafia do payloadu,
 * - paczka przechodzi egress firewall jeszcze przed kolejką.
 */
export async function buildEvidencePayload(args: {
  sessionId: string;
  modelId: string;
  promptVersion: string;
  fsmState: FsmState;
  transcript: LocalChatMessage[];
  output: EvaluatorOutput;
}): Promise<TraitEvidencePayload> {
  const byId = new Map(args.transcript.map((m) => [m.id, m]));

  const deduped = new Map<string, (typeof args.output.evidence)[number]>();
  for (const row of args.output.evidence) {
    const key = `${row.probeId}:${row.traitKey}`;
    const previous = deduped.get(key);
    if (!previous || row.confidence > previous.confidence) deduped.set(key, row);
  }

  const top = [...deduped.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_EVIDENCE_PER_SESSION);

  const evidence = await Promise.all(
    top.map(async (row) => {
      const source = byId.get(row.sourceMessageId);
      if (!source) throw new Error('EVIDENCE_SOURCE_MESSAGE_NOT_FOUND');
      return {
        probe_id: row.probeId,
        trait_key: row.traitKey,
        score: row.score,
        confidence: row.confidence,
        evidence_class: row.evidenceClass,
        evidence_hash: await sha256Prefixed(source.text),
        rationale_code: row.rationaleCode,
      };
    }),
  );

  const safety_flags = await Promise.all(
    args.output.safetyFlags.map(async (flag) => {
      const source = byId.get(flag.sourceMessageId);
      if (!source) throw new Error('FLAG_SOURCE_MESSAGE_NOT_FOUND');
      return {
        flag_code: flag.flagCode,
        severity: flag.severity,
        confidence: flag.confidence,
        evidence_hash: await sha256Prefixed(source.text),
      };
    }),
  );

  return assertEvidencePayload({
    session_id: args.sessionId,
    prompt_version: args.promptVersion,
    model_id: args.modelId,
    fsm_state: args.fsmState,
    evidence,
    safety_flags,
    next_fsm_state: args.output.nextFsmState,
    signed_at: new Date().toISOString(),
  });
}

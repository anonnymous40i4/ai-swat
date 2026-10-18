import type { EvidenceClass, FsmState, TraitKey } from './traits';

/** Wiadomość czatu: typ WYŁĄCZNIE lokalny. Nigdy nie jest serializowana do sieci. */
export type LocalChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
};

/** Surowy wynik ewaluatora on-device: nadal zawiera tylko ID wiadomości źródłowej. */
export type RawTraitEvidence = {
  probeId: string;
  traitKey: TraitKey;
  score: number;
  confidence: number;
  evidenceClass: EvidenceClass;
  rationaleCode: string;
  sourceMessageId: string;
};

export type RawSafetyFlag = {
  flagCode:
    | 'THREAT_TO_IDENTIFIABLE_PERSON'
    | 'AGGRESSION_ENDORSEMENT'
    | 'CONSENT_DISREGARD'
    | 'COERCION_ENDORSEMENT'
    | 'DECEPTION_ENDORSEMENT'
    | 'MINOR_SAFETY'
    | 'SELF_HARM_RISK';
  severity: 1 | 2 | 3 | 4 | 5;
  confidence: number;
  sourceMessageId: string;
};

export type EvaluatorOutput = {
  evidence: RawTraitEvidence[];
  safetyFlags: RawSafetyFlag[];
  nextFsmState: FsmState | 'READY_FOR_SWARM' | 'PAUSED';
};

/** Dokładny kształt wysyłany do Edge Function ingest-evidence (snake_case pod kontrakt JSON). */
export type TraitEvidencePayload = {
  session_id: string;
  prompt_version: string;
  model_id: string;
  fsm_state: FsmState;
  evidence: Array<{
    probe_id: string;
    trait_key: TraitKey;
    score: number;
    confidence: number;
    evidence_class: EvidenceClass;
    evidence_hash: string;
    rationale_code: string;
  }>;
  safety_flags: Array<{
    flag_code: RawSafetyFlag['flagCode'];
    severity: number;
    confidence: number;
    evidence_hash: string;
  }>;
  next_fsm_state: EvaluatorOutput['nextFsmState'];
  signed_at: string;
  device_signature?: string;
};

export type TelemetryOutboxItem = {
  id: string;
  payload: TraitEvidencePayload;
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  lastErrorCode?: string;
};

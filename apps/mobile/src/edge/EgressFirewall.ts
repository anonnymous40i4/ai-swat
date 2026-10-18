import type { TraitEvidencePayload } from '@/contracts/evidence';
import { TRAIT_KEYS } from '@/contracts/traits';

/**
 * Egress firewall: ostatnia linia przed siecią. Działa na whiteliście pól,
 * nie blackliście treści. Każdy nieznany klucz lub wartość spoza zakresów
 * = twarde odrzucenie paczki (bez logowania jej zawartości).
 */
export class EgressViolation extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'EgressViolation';
  }
}

const TOP_LEVEL_KEYS = new Set([
  'session_id', 'prompt_version', 'model_id', 'fsm_state', 'evidence',
  'safety_flags', 'next_fsm_state', 'signed_at', 'device_signature',
]);
const EVIDENCE_KEYS = new Set([
  'probe_id', 'trait_key', 'score', 'confidence', 'evidence_class', 'evidence_hash', 'rationale_code',
]);
const FLAG_KEYS = new Set(['flag_code', 'severity', 'confidence', 'evidence_hash']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const PROBE_RE = /^[A-Z0-9-]{3,32}$/;
const CODE_RE = /^[A-Z0-9_]{3,64}$/;

function assertExactKeys(record: Record<string, unknown>, allowed: Set<string>, required: string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new EgressViolation(`EGRESS_UNKNOWN_KEY:${key}`);
  }
  for (const key of required) {
    if (!(key in record)) throw new EgressViolation(`EGRESS_MISSING_KEY:${key}`);
  }
}

function inRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

export const MAX_EVIDENCE_PER_SESSION = 10;

export function assertEvidencePayload(payload: TraitEvidencePayload): TraitEvidencePayload {
  const record = payload as unknown as Record<string, unknown>;
  assertExactKeys(record, TOP_LEVEL_KEYS, [
    'session_id', 'prompt_version', 'model_id', 'fsm_state', 'evidence', 'safety_flags', 'next_fsm_state', 'signed_at',
  ]);

  if (typeof payload.session_id !== 'string' || !UUID_RE.test(payload.session_id)) {
    throw new EgressViolation('EGRESS_BAD_SESSION_ID');
  }
  if (!Array.isArray(payload.evidence) || payload.evidence.length > MAX_EVIDENCE_PER_SESSION) {
    throw new EgressViolation('EGRESS_EVIDENCE_BATCH_TOO_LARGE');
  }
  if (!Array.isArray(payload.safety_flags) || payload.safety_flags.length > 8) {
    throw new EgressViolation('EGRESS_FLAGS_TOO_MANY');
  }

  for (const row of payload.evidence) {
    assertExactKeys(row as unknown as Record<string, unknown>, EVIDENCE_KEYS, [...EVIDENCE_KEYS]);
    if (!PROBE_RE.test(row.probe_id)) throw new EgressViolation('EGRESS_BAD_PROBE_ID');
    if (!TRAIT_KEYS.has(row.trait_key)) throw new EgressViolation('EGRESS_UNKNOWN_TRAIT');
    if (!inRange(row.score, -1, 1) || !inRange(row.confidence, 0, 1)) throw new EgressViolation('EGRESS_BAD_SCORE');
    if (!HASH_RE.test(row.evidence_hash)) throw new EgressViolation('EGRESS_BAD_HASH');
    if (!CODE_RE.test(row.rationale_code)) throw new EgressViolation('EGRESS_BAD_RATIONALE_CODE');
  }

  for (const flag of payload.safety_flags) {
    assertExactKeys(flag as unknown as Record<string, unknown>, FLAG_KEYS, [...FLAG_KEYS]);
    if (!CODE_RE.test(flag.flag_code) || !HASH_RE.test(flag.evidence_hash)) throw new EgressViolation('EGRESS_BAD_FLAG');
    if (!inRange(flag.severity, 1, 5) || !inRange(flag.confidence, 0, 1)) throw new EgressViolation('EGRESS_BAD_FLAG_RANGE');
  }

  const serialized = JSON.stringify(payload);
  if (serialized.length > 32 * 1024) throw new EgressViolation('EGRESS_PAYLOAD_TOO_LARGE');
  return payload;
}

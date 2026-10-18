import { env } from '@/config/env';
import type { TraitEvidencePayload } from '@/contracts/evidence';
import { DeviceSigner } from '@/edge/DeviceSigner';
import { assertEvidencePayload } from '@/edge/EgressFirewall';
import { supabase } from '@/lib/supabase';

export type UploadResult =
  | { ok: true }
  | { ok: false; retryable: boolean; errorCode: string };

/** Jedyny wychodzący kanał telemetrii: JWT użytkownika -> Edge Function ingest-evidence. */
export async function uploadEvidence(payload: TraitEvidencePayload): Promise<UploadResult> {
  assertEvidencePayload(payload); // twarda bramka jeszcze przed podpisem i siecią

  if (!env.isSupabaseConfigured) {
    return { ok: false, retryable: false, errorCode: 'DEMO_LOCAL_ONLY' };
  }

  let keyId: string;
  let signature: string;
  try {
    const canonical = JSON.stringify(payload);
    ({ keyId, signature } = await DeviceSigner.sign(canonical));
  } catch {
    return { ok: false, retryable: false, errorCode: 'DEVICE_SIGNER_NOT_LINKED' };
  }

  const { error } = await supabase.functions.invoke('ingest-evidence', {
    body: { ...payload, device_signature: signature },
    headers: { 'x-device-key-id': keyId },
  });

  if (!error) return { ok: true };
  const status = (error as { context?: { status?: number } }).context?.status;
  const retryable = status === undefined || status >= 500 || status === 429;
  return { ok: false, retryable, errorCode: `INGEST_HTTP_${status ?? 'NETWORK'}` };
}

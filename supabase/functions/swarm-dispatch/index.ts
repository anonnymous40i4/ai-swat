// Dispatcher outboxa -> Abacus executeAgent.
// Wywołanie: harmonogram Supabase (pg_cron / Scheduled Functions) co 1 min
// z nagłówkiem x-dispatch-secret. Zdarzenie zawiera tylko swarm_uid;
// wektor pobiera węzeł A przez HMAC-owy endpoint swarm-candidates.
//
// API Abacus (dokumentacja executeAgent):
//   POST https://api.abacus.ai/api/executeAgent?deploymentToken=...&deploymentId=...
//   body (form): arguments=[]  keywordArguments={"event_id":...}

import { supabaseAdmin } from "../_shared/admin.ts";
import { errorResponse, jsonResponse, requiredEnv } from "../_shared/http.ts";

type OutboxEvent = {
  id: string;
  idempotency_key: string;
  event_type: string;
  swarm_uid: string;
  vector_version: string;
  attempts: number;
};

function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function executeAbacusAgent(event: OutboxEvent): Promise<{ ok: boolean; errorCode?: string }> {
  const url = new URL("https://api.abacus.ai/api/executeAgent");
  url.searchParams.set("deploymentToken", requiredEnv("ABACUS_DEPLOYMENT_TOKEN"));
  url.searchParams.set("deploymentId", requiredEnv("ABACUS_MASTER_DEPLOYMENT_ID"));

  const keywordArguments = {
    event_id: event.id,
    event_type: event.event_type,
    swarm_uid: event.swarm_uid,
    vector_version: event.vector_version,
    idempotency_key: event.idempotency_key,
    issued_at: new Date().toISOString(),
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        arguments: "[]",
        keywordArguments: JSON.stringify(keywordArguments),
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) return { ok: false, errorCode: `ABACUS_HTTP_${response.status}` };
    const parsed: unknown = await response.json().catch(() => null);
    if (typeof parsed === "object" && parsed !== null && "success" in parsed && parsed.success !== true) {
      return { ok: false, errorCode: "ABACUS_SUCCESS_FALSE" };
    }
    return { ok: true };
  } catch {
    return { ok: false, errorCode: "ABACUS_NETWORK_OR_TIMEOUT" };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405);
  const provided = req.headers.get("x-dispatch-secret") ?? "";
  if (!secretsEqual(provided, requiredEnv("DISPATCH_SECRET"))) {
    return errorResponse("INVALID_DISPATCH_SECRET", 401);
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc("fn_claim_swarm_events", {
    p_limit: 6,
    p_worker: "edge:swarm-dispatch",
  });
  if (error) {
    console.error("fn_claim_swarm_events_failed", { code: error.code });
    return errorResponse("CLAIM_FAILED", 500);
  }

  const events = (data ?? []) as OutboxEvent[];
  let acked = 0;
  let failed = 0;

  // Małe paczki współbieżne: limit czasu Edge Function > przepustowość na siłę.
  for (let offset = 0; offset < events.length; offset += 3) {
    const batch = events.slice(offset, offset + 3);
    const results = await Promise.all(batch.map((event) => executeAbacusAgent(event)));
    for (let i = 0; i < batch.length; i += 1) {
      const result = results[i];
      const { error: finishError } = await admin.rpc("fn_finish_swarm_event", {
        p_event_id: batch[i].id,
        p_success: result.ok,
        p_error_code: result.ok ? null : result.errorCode ?? "ABACUS_UNKNOWN",
      });
      if (finishError) console.error("fn_finish_swarm_event_failed", { code: finishError.code });
      if (result.ok) acked += 1;
      else failed += 1;
    }
  }

  return jsonResponse({ claimed: events.length, acked, failed });
});

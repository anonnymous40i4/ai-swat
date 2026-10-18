// Supabase -> Abacus (węzeł A FetchCandidateBundle).
// verify_jwt=false w config.toml; jedyną autoryzacją jest HMAC service-to-service.
// Odpowiedź: contracts/candidate_bundle.schema.json. Zero user_id, zero PII.

import { supabaseAdmin } from "../_shared/admin.ts";
import { verifySwarmHmac } from "../_shared/hmac.ts";
import { errorResponse, isRecord, jsonResponse, readRawBody, requiredEnv, UUID_RE } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405);

  const rawBody = await readRawBody(req, 16 * 1024);
  if (rawBody === null) return errorResponse("PAYLOAD_TOO_LARGE", 413);
  if (!(await verifySwarmHmac(req, rawBody, requiredEnv("SWARM_SHARED_SECRET")))) {
    return errorResponse("INVALID_SIGNATURE", 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  if (!isRecord(payload) || typeof payload.swarm_uid !== "string" || !UUID_RE.test(payload.swarm_uid)) {
    return errorResponse("INVALID_SWARM_UID", 400);
  }

  const requestedLimit = typeof payload.limit === "number" ? Math.trunc(payload.limit) : 200;
  const limit = Math.max(1, Math.min(requestedLimit, 200));

  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc("fn_swarm_candidate_bundle", {
    p_source_swarm_uid: payload.swarm_uid,
    p_limit: limit,
  });
  if (error) {
    console.error("fn_swarm_candidate_bundle_failed", { code: error.code });
    return errorResponse("BUNDLE_FAILED", 500);
  }
  return jsonResponse(data);
});

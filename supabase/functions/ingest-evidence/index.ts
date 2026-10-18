// Telefon (Osobisty Agent on-device) -> Supabase: jedyna droga zapisu evidence.
// Przyjmuje wyłącznie liczby/hashe wg contracts/trait_evidence.schema.json,
// agreguje trait_scores, przelicza wektor roju i PoS. Zapis wektora wyzwala
// trigger outboxa -> swarm-dispatch -> Abacus Master.
//
// Podpis urządzenia: produkcyjnie wymagany aktywny klucz z device_keys
// (weryfikator Ed25519 podmieniany w miejscu oznaczonym TODO).
// ALLOW_UNSIGNED_EVIDENCE=true wolno ustawić WYŁĄCZNIE lokalnie/dev.

import { supabaseAdmin, supabaseAsUser } from "../_shared/admin.ts";
import {
  asFiniteNumber,
  errorResponse,
  isRecord,
  jsonResponse,
  readRawBody,
  UUID_RE,
} from "../_shared/http.ts";

const FORBIDDEN_KEYS = new Set([
  "transcript", "text", "message", "messages", "content", "quote", "quotes",
  "name", "first_name", "last_name", "email", "phone", "address",
  "latitude", "longitude", "gps", "photo", "image", "audio", "weight",
  "height", "salary", "income", "diagnosis", "health",
]);

const SAFETY_GATES = [
  "safety_non_aggression",
  "safety_boundary_respect",
  "safety_consent_respect",
  "safety_non_coercion",
  "safety_accountability",
] as const;

const GATE_TO_COLUMN: Record<(typeof SAFETY_GATES)[number], string> = {
  safety_non_aggression: "gate_non_aggression",
  safety_boundary_respect: "gate_boundary_respect",
  safety_consent_respect: "gate_consent_respect",
  safety_non_coercion: "gate_non_coercion",
  safety_accountability: "gate_accountability",
};

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) return true;
    if (containsForbiddenKey(nested)) return true;
  }
  return false;
}

type EvidenceRow = {
  probe_id: string;
  trait_key: string;
  score: number;
  confidence: number;
  evidence_class: string;
  evidence_hash: string;
  rationale_code: string;
};

type FlagRow = { flag_code: string; severity: number; confidence: number; evidence_hash: string };

const HASH_RE = /^sha256:[a-f0-9]{64}$/;

function parseEvidence(value: unknown): EvidenceRow | null {
  if (!isRecord(value)) return null;
  const score = asFiniteNumber(value.score);
  const confidence = asFiniteNumber(value.confidence);
  if (score === null || score < -1 || score > 1 || confidence === null || confidence < 0 || confidence > 1) return null;
  if (typeof value.probe_id !== "string" || !/^[A-Z0-9-]{3,32}$/.test(value.probe_id)) return null;
  if (typeof value.trait_key !== "string" || !/^[a-z0-9_]{3,48}$/.test(value.trait_key)) return null;
  if (typeof value.evidence_hash !== "string" || !HASH_RE.test(value.evidence_hash)) return null;
  if (typeof value.rationale_code !== "string" || value.rationale_code.length < 3 || value.rationale_code.length > 64) return null;
  if (!["self_declared", "sjt_response", "consistency", "user_correction"].includes(String(value.evidence_class))) return null;
  return {
    probe_id: value.probe_id,
    trait_key: value.trait_key,
    score,
    confidence,
    evidence_class: String(value.evidence_class),
    evidence_hash: value.evidence_hash,
    rationale_code: value.rationale_code,
  };
}

function parseFlag(value: unknown): FlagRow | null {
  if (!isRecord(value)) return null;
  const confidence = asFiniteNumber(value.confidence);
  if (confidence === null || confidence < 0 || confidence > 1) return null;
  if (typeof value.flag_code !== "string") return null;
  if (typeof value.evidence_hash !== "string" || !HASH_RE.test(value.evidence_hash)) return null;
  if (typeof value.severity !== "number" || value.severity < 1 || value.severity > 5) return null;
  return {
    flag_code: value.flag_code,
    severity: Math.trunc(value.severity),
    confidence,
    evidence_hash: value.evidence_hash,
  };
}

type Admin = ReturnType<typeof supabaseAdmin>;

async function recomputeTraitScores(admin: Admin, userId: string, traitKeys: string[]): Promise<void> {
  const { data: dictionary, error: dictError } = await admin
    .from("trait_dictionary")
    .select("trait_key,min_probes")
    .in("trait_key", traitKeys);
  if (dictError) throw new Error("DICTIONARY_LOOKUP_FAILED");
  const minProbes = new Map((dictionary ?? []).map((row) => [row.trait_key as string, Number(row.min_probes ?? 3)]));

  for (const traitKey of traitKeys) {
    const { data: rows, error } = await admin
      .from("trait_evidence")
      .select("score,confidence,probe_id,created_at")
      .eq("user_id", userId)
      .eq("trait_key", traitKey)
      .order("created_at", { ascending: false })
      .limit(90);
    if (error) throw new Error("EVIDENCE_LOOKUP_FAILED");
    if (!rows || rows.length === 0) continue;

    const weightSum = rows.reduce((sum, row) => sum + Math.max(0.01, Number(row.confidence)), 0);
    const weightedScore = rows.reduce(
      (sum, row) => sum + Number(row.score) * Math.max(0.01, Number(row.confidence)),
      0,
    ) / weightSum;
    const meanScore = rows.reduce((sum, row) => sum + Number(row.score), 0) / rows.length;
    const variance = rows.reduce((sum, row) => sum + (Number(row.score) - meanScore) ** 2, 0) / rows.length;
    const stddev = Math.sqrt(variance);
    const meanConfidence = rows.reduce((sum, row) => sum + Number(row.confidence), 0) / rows.length;
    const distinctProbes = new Set(rows.map((row) => row.probe_id as string)).size;
    const distinctDays = new Set(rows.map((row) => String(row.created_at).slice(0, 10))).size;
    const requiredProbes = Math.max(3, minProbes.get(traitKey) ?? 3);

    const isHardPoint =
      rows.length >= requiredProbes &&
      distinctProbes >= requiredProbes &&
      distinctDays >= 2 &&
      meanConfidence >= 0.7 &&
      stddev <= 0.45;

    const { error: upsertError } = await admin.from("trait_scores").upsert(
      {
        user_id: userId,
        trait_key: traitKey,
        vector_version: "vec-v1",
        score: Math.max(-1, Math.min(1, weightedScore)),
        confidence: meanConfidence,
        evidence_count: rows.length,
        distinct_probes: distinctProbes,
        distinct_days: distinctDays,
        score_stddev: stddev,
        is_hard_point: isHardPoint,
      },
      { onConflict: "user_id,trait_key,vector_version" },
    );
    if (upsertError) throw new Error("TRAIT_SCORE_UPSERT_FAILED");
  }
}

async function recomputeVectorAndSafety(
  admin: Admin,
  userId: string,
): Promise<{ coverage: number; hardPoints: number; posStatus: string }> {
  const [{ data: dictionary, error: dictError }, { data: scores, error: scoreError }, { data: vault, error: vaultError }] =
    await Promise.all([
      admin.from("trait_dictionary").select("trait_key,dimension_index,category").eq("active", true),
      admin.from("trait_scores").select("trait_key,score,confidence,is_hard_point").eq("user_id", userId).eq("vector_version", "vec-v1"),
      admin.from("identity_vault").select("swarm_uid").eq("user_id", userId).maybeSingle(),
    ]);
  if (dictError || scoreError || vaultError || !vault) throw new Error("VECTOR_RECOMPUTE_LOOKUP_FAILED");

  const scoreByTrait = new Map((scores ?? []).map((row) => [row.trait_key as string, row]));
  const embedding = new Array<number>(32).fill(0);
  const maskChars = new Array<string>(32).fill("0");
  let hardDimensions = 0;
  let hardConfidenceSum = 0;
  const intentTraitKeys: string[] = [];

  for (const trait of dictionary ?? []) {
    if (trait.category === "intent") intentTraitKeys.push(trait.trait_key as string);
    if (typeof trait.dimension_index !== "number") continue;
    const row = scoreByTrait.get(trait.trait_key as string);
    if (!row || row.is_hard_point !== true) continue;
    embedding[trait.dimension_index] = Number(row.score);
    maskChars[trait.dimension_index] = "1";
    hardDimensions += 1;
    hardConfidenceSum += Number(row.confidence);
  }

  const coverage = hardDimensions / 32;
  const overallConfidence = hardDimensions > 0 ? hardConfidenceSum / hardDimensions : 0;

  const { error: vectorError } = await admin.from("swarm_vectors").upsert(
    {
      swarm_uid: vault.swarm_uid,
      vector_version: "vec-v1",
      embedding: `[${embedding.map((v) => Number(v.toFixed(6))).join(",")}]`,
      coverage_mask: maskChars.join(""),
      coverage,
      overall_confidence: overallConfidence,
    },
    { onConflict: "swarm_uid" },
  );
  if (vectorError) throw new Error("SWARM_VECTOR_UPSERT_FAILED");

  // PoS wg Blueprintu A.4. Skala bramek 0..1 = (score+1)/2.
  const gateValues = new Map<string, number>();
  const gateUpdate: Record<string, unknown> = { user_id: userId };
  let allGatesKnown = true;
  let allGatesHard = true;
  for (const gate of SAFETY_GATES) {
    const row = scoreByTrait.get(gate);
    if (!row) {
      allGatesKnown = false;
      allGatesHard = false;
      gateUpdate[GATE_TO_COLUMN[gate]] = null;
      continue;
    }
    const value = (Number(row.score) + 1) / 2;
    gateValues.set(gate, value);
    gateUpdate[GATE_TO_COLUMN[gate]] = value;
    if (row.is_hard_point !== true) allGatesHard = false;
  }

  const { count: severeFlags, error: flagError } = await admin
    .from("red_flag_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("resolved", false)
    .gte("severity", 4);
  if (flagError) throw new Error("FLAG_LOOKUP_FAILED");

  let posScore: number | null = null;
  let minGate: number | null = null;
  if (allGatesKnown) {
    posScore = Math.round(
      100 *
        (0.3 * gateValues.get("safety_non_aggression")! +
          0.25 * gateValues.get("safety_boundary_respect")! +
          0.25 * gateValues.get("safety_consent_respect")! +
          0.1 * gateValues.get("safety_non_coercion")! +
          0.1 * gateValues.get("safety_accountability")!),
    );
    minGate = Math.min(...gateValues.values());
  }

  let posStatus = "provisional";
  if ((severeFlags ?? 0) > 0) posStatus = "quarantined";
  else if (allGatesHard && posScore !== null && posScore >= 75 && (minGate ?? 0) >= 0.65) posStatus = "passed";
  else if (allGatesKnown && posScore !== null && posScore < 60) posStatus = "quarantined";
  else if (posScore !== null && (posScore < 75 || (minGate ?? 1) < 0.65)) posStatus = "watch";

  const now = new Date();
  const expires = posStatus === "passed" ? new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000) : null;
  const { error: safetyError } = await admin.from("safety_assessments").upsert(
    {
      ...gateUpdate,
      pos_status: posStatus,
      pos_score: posScore,
      assessed_at: now.toISOString(),
      expires_at: expires?.toISOString() ?? null,
      human_review_status: posStatus === "quarantined" ? "pending" : "none",
    },
    { onConflict: "user_id" },
  );
  if (safetyError) throw new Error("SAFETY_UPSERT_FAILED");

  const allIntentHard = intentTraitKeys.every((key) => scoreByTrait.get(key)?.is_hard_point === true);
  const ready = posStatus === "passed" && coverage >= 0.75 && allIntentHard;
  const { data: appUser } = await admin.from("app_users").select("status").eq("id", userId).maybeSingle();
  if (appUser && !["paused", "quarantined", "suspended", "deleted"].includes(String(appUser.status))) {
    await admin
      .from("app_users")
      .update({ status: posStatus === "quarantined" ? "quarantined" : ready ? "ready_for_swarm" : "profiling" })
      .eq("id", userId);
  }

  return { coverage, hardPoints: hardDimensions, posStatus };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405);

  const authorization = req.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return errorResponse("MISSING_JWT", 401);

  const rawBody = await readRawBody(req, 64 * 1024);
  if (rawBody === null) return errorResponse("PAYLOAD_TOO_LARGE", 413);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  if (!isRecord(payload) || containsForbiddenKey(payload)) return errorResponse("FORBIDDEN_FIELD", 400);

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!UUID_RE.test(sessionId)) return errorResponse("INVALID_SESSION_ID", 400);
  if (typeof payload.prompt_version !== "string" || typeof payload.model_id !== "string") {
    return errorResponse("INVALID_VERSION_METADATA", 400);
  }
  if (!Array.isArray(payload.evidence) || payload.evidence.length > 24) return errorResponse("INVALID_EVIDENCE", 400);
  if (!Array.isArray(payload.safety_flags) || payload.safety_flags.length > 8) return errorResponse("INVALID_FLAGS", 400);

  const evidence = payload.evidence.map(parseEvidence);
  const flags = payload.safety_flags.map(parseFlag);
  if (evidence.some((row) => row === null) || flags.some((row) => row === null)) {
    return errorResponse("INVALID_EVIDENCE_ROW", 400);
  }

  const asUser = supabaseAsUser(authorization);
  const { data: userData, error: userError } = await asUser.auth.getUser();
  if (userError || !userData.user) return errorResponse("INVALID_JWT", 401);
  const userId = userData.user.id;
  const admin = supabaseAdmin();

  // --- podpis urządzenia -------------------------------------------------
  const allowUnsigned = Deno.env.get("ALLOW_UNSIGNED_EVIDENCE") === "true";
  if (!allowUnsigned) {
    const deviceKeyId = req.headers.get("x-device-key-id") ?? "";
    if (!UUID_RE.test(deviceKeyId) || typeof payload.device_signature !== "string") {
      return errorResponse("DEVICE_SIGNATURE_REQUIRED", 401);
    }
    const { data: key } = await admin
      .from("device_keys")
      .select("id,public_key,algorithm")
      .eq("id", deviceKeyId)
      .eq("user_id", userId)
      .eq("is_active", true)
      .maybeSingle();
    if (!key) return errorResponse("DEVICE_KEY_NOT_ACTIVE", 401);
    // TODO(produkcja): zweryfikować payload.device_signature (Ed25519) na
    // kanonicznym JSON bez pola device_signature kluczem key.public_key.
    // Do czasu podpięcia weryfikatora produkcja świadomie odmawia zapisu:
    return errorResponse("DEVICE_SIGNATURE_VERIFIER_NOT_CONFIGURED", 501);
  }

  try {
    // Idempotencja paczki: jedna sesja = jedna paczka evidence.
    const { count: existingEvidence, error: existingError } = await admin
      .from("trait_evidence")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId);
    if (existingError) throw new Error("IDEMPOTENCY_LOOKUP_FAILED");
    if ((existingEvidence ?? 0) > 0) return jsonResponse({ duplicate: true });

    const { error: sessionError } = await admin.from("agent_sessions").upsert(
      {
        id: sessionId,
        user_id: userId,
        model_id: payload.model_id,
        prompt_version: payload.prompt_version,
        fsm_state: typeof payload.fsm_state === "string" ? payload.fsm_state : "UNKNOWN",
        turns_count: 0,
        ended_at: typeof payload.signed_at === "string" ? payload.signed_at : new Date().toISOString(),
      },
      { onConflict: "id", ignoreDuplicates: true },
    );
    if (sessionError) throw new Error("SESSION_INSERT_FAILED");

    const evidenceRows = (evidence as EvidenceRow[]).map((row) => ({
      ...row,
      user_id: userId,
      session_id: sessionId,
      prompt_version: payload.prompt_version as string,
    }));
    if (evidenceRows.length > 0) {
      const { error } = await admin.from("trait_evidence").insert(evidenceRows);
      if (error) throw new Error("EVIDENCE_INSERT_FAILED");
    }

    const flagRows = (flags as FlagRow[]).map((row) => ({ ...row, user_id: userId, session_id: sessionId }));
    if (flagRows.length > 0) {
      const { error } = await admin.from("red_flag_events").insert(flagRows);
      if (error) throw new Error("FLAG_INSERT_FAILED");
    }

    // memory_slot_updates celowo NIE jest persystowane: pamięć Agenta żyje na urządzeniu.
    const affectedTraits = [...new Set(evidenceRows.map((row) => row.trait_key))];
    await recomputeTraitScores(admin, userId, affectedTraits);
    const summary = await recomputeVectorAndSafety(admin, userId);

    return jsonResponse({
      accepted: true,
      evidence_count: evidenceRows.length,
      hard_points: summary.hardPoints,
      coverage: Number(summary.coverage.toFixed(4)),
      pos_status: summary.posStatus,
    });
  } catch (error) {
    console.error("ingest_evidence_failed", { code: error instanceof Error ? error.message : "UNKNOWN" });
    return errorResponse("INGEST_FAILED", 500);
  }
});

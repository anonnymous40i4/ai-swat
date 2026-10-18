// Abacus (węzeł D) -> Supabase: wynik Master Swat Agenta.
// verify_jwt=false; autoryzacja wyłącznie HMAC. Ta funkcja jest OSTATNIM
// strażnikiem: przelicza display_score sama i rewaliduje parę przez
// fn_swarm_candidate_bundle, bo PoS/blokada/pauza mogły się zmienić w trakcie runu.

import { supabaseAdmin } from "../_shared/admin.ts";
import { sha256Hex, verifySwarmHmac } from "../_shared/hmac.ts";
import {
  asFiniteNumber,
  errorResponse,
  isRecord,
  jsonResponse,
  readRawBody,
  requiredEnv,
  UUID_RE,
} from "../_shared/http.ts";

type Proposal = {
  candidate_swarm_uid: string;
  raw_similarity: number;
  component_scores: Record<string, number>;
  overlap_dimensions: number;
};

const COMPONENT_KEYS = ["intent", "values", "communication", "lifestyle"] as const;

function displayScore(raw: number): number | null {
  if (raw < 0.78) return null;
  return Math.min(99, Math.round(80 + (20 * (raw - 0.78)) / 0.22));
}

function parseProposal(value: unknown): Proposal | null {
  if (!isRecord(value)) return null;
  if (typeof value.candidate_swarm_uid !== "string" || !UUID_RE.test(value.candidate_swarm_uid)) return null;
  const raw = asFiniteNumber(value.raw_similarity);
  if (raw === null || raw < 0.78 || raw > 1) return null;
  if (typeof value.overlap_dimensions !== "number" || value.overlap_dimensions < 24 || value.overlap_dimensions > 32) return null;
  if (!isRecord(value.component_scores)) return null;

  const components: Record<string, number> = {};
  for (const key of COMPONENT_KEYS) {
    const component = asFiniteNumber(value.component_scores[key]);
    if (component === null || component < -1 || component > 1) return null;
    components[key] = component;
  }
  return {
    candidate_swarm_uid: value.candidate_swarm_uid,
    raw_similarity: raw,
    component_scores: components,
    overlap_dimensions: Math.trunc(value.overlap_dimensions),
  };
}

type Admin = ReturnType<typeof supabaseAdmin>;

async function resolveUserIds(admin: Admin, swarmUids: string[]): Promise<Map<string, string>> {
  const { data, error } = await admin
    .from("identity_vault")
    .select("user_id,swarm_uid")
    .in("swarm_uid", swarmUids);
  if (error) throw new Error("IDENTITY_LOOKUP_FAILED");
  return new Map((data ?? []).map((row) => [row.swarm_uid as string, row.user_id as string]));
}

async function notifyMatch(admin: Admin, matchId: string, score: number, userIds: string[]): Promise<void> {
  const { error: notificationError } = await admin.from("match_notifications").upsert(
    userIds.map((userId) => ({ match_id: matchId, recipient_user_id: userId })),
    { onConflict: "match_id,recipient_user_id", ignoreDuplicates: true },
  );
  if (notificationError) throw new Error("NOTIFICATION_INSERT_FAILED");

  const { data: devices, error: deviceError } = await admin
    .from("push_devices")
    .select("user_id,expo_push_token")
    .in("user_id", userIds)
    .eq("notifications_enabled", true);
  if (deviceError) throw new Error("PUSH_DEVICE_LOOKUP_FAILED");
  if (!devices || devices.length === 0) return;

  const messages = devices.map((device) => ({
    to: device.expo_push_token,
    sound: "default",
    title: "Znalazłem kandydata",
    body: `Zgodność zamiarów i wartości: ${score}/100`,
    data: { type: "MATCH_PROPOSED", match_id: matchId },
  }));

  let pushOk = false;
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(15_000),
    });
    pushOk = response.ok;
  } catch {
    pushOk = false;
  }

  await admin
    .from("match_notifications")
    .update(
      pushOk
        ? { status: "push_sent", pushed_at: new Date().toISOString() }
        : { status: "push_failed" },
    )
    .eq("match_id", matchId)
    .in("recipient_user_id", [...new Set(devices.map((d) => d.user_id as string))]);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", 405);

  const rawBody = await readRawBody(req, 64 * 1024);
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
  if (!isRecord(payload) || payload.schema !== "master-result-v1") return errorResponse("INVALID_SCHEMA", 400);

  const eventId = typeof payload.event_id === "string" ? payload.event_id : "";
  const runRef = typeof payload.run_ref === "string" ? payload.run_ref : "";
  const source = typeof payload.source_swarm_uid === "string" ? payload.source_swarm_uid : "";
  const decision = typeof payload.decision === "string" ? payload.decision : "";
  if (!UUID_RE.test(eventId) || !UUID_RE.test(runRef) || !UUID_RE.test(source)) {
    return errorResponse("INVALID_IDS", 400);
  }
  if (!["MATCHED", "NO_MATCH", "INELIGIBLE"].includes(decision)) return errorResponse("INVALID_DECISION", 400);
  if (!Array.isArray(payload.proposals) || payload.proposals.length > 3) return errorResponse("INVALID_PROPOSALS", 400);

  const proposals = payload.proposals.map(parseProposal);
  if (decision === "MATCHED" && (proposals.length === 0 || proposals.some((p) => p === null))) {
    return errorResponse("INVALID_PROPOSALS", 400);
  }

  const candidatesSeen = Math.max(0, Math.min(200, Math.trunc(asFiniteNumber(payload.candidates_seen) ?? 0)));
  const candidatesScored = Math.max(0, Math.min(200, Math.trunc(asFiniteNumber(payload.candidates_scored) ?? 0)));
  const bestSimilarity = asFiniteNumber(payload.best_similarity);
  const admin = supabaseAdmin();

  try {
    const { data: existingRun } = await admin
      .from("abacus_runs")
      .select("id,result_match_id")
      .eq("external_run_ref", runRef)
      .maybeSingle();
    if (existingRun) {
      return jsonResponse({ duplicate: true, match_id: existingRun.result_match_id });
    }

    const { data: event, error: eventError } = await admin
      .from("swarm_events_outbox")
      .select("id,swarm_uid")
      .eq("id", eventId)
      .maybeSingle();
    if (eventError || !event || event.swarm_uid !== source) return errorResponse("EVENT_MISMATCH", 404);

    const { data: matchRun, error: matchRunError } = await admin
      .from("match_runs")
      .insert({
        master_version: typeof payload.master_version === "string" ? payload.master_version : "master-v1.0",
        params: { source: "abacus", event_id: eventId, run_ref: runRef },
        candidates_seen: candidatesSeen,
        Matches_created: 0,
        finished_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (matchRunError || !matchRun) throw new Error("MATCH_RUN_INSERT_FAILED");

    const { data: run, error: runError } = await admin
      .from("abacus_runs")
      .insert({
        event_id: eventId,
        external_run_ref: runRef,
        source_swarm_uid: source,
        master_version: typeof payload.master_version === "string" ? payload.master_version : "master-v1.0",
        status: "running",
        candidates_seen: candidatesSeen,
        candidates_scored: candidatesScored,
        best_similarity: bestSimilarity,
      })
      .select("id")
      .single();
    if (runError || !run) throw new Error("ABACUS_RUN_INSERT_FAILED");

    let createdMatch: { id: string; display_score: number } | null = null;

    if (decision === "MATCHED") {
      // Rewalidacja: bundle na żywo odcina pauzy, blokady, wygasły PoS i istniejące pary.
      const { data: bundle, error: bundleError } = await admin.rpc("fn_swarm_candidate_bundle", {
        p_source_swarm_uid: source,
        p_limit: 200,
      });
      if (bundleError || !isRecord(bundle)) throw new Error("REVALIDATION_FAILED");

      const liveCandidateIds = new Set<string>();
      if (bundle.source_eligible === true && Array.isArray(bundle.candidates)) {
        for (const candidate of bundle.candidates) {
          if (isRecord(candidate) && typeof candidate.swarm_uid === "string") liveCandidateIds.add(candidate.swarm_uid);
        }
      }

      for (const proposal of proposals) {
        if (!proposal || !liveCandidateIds.has(proposal.candidate_swarm_uid)) continue;
        const score = displayScore(proposal.raw_similarity);
        if (score === null) continue;
        const [swarmA, swarmB] = [source, proposal.candidate_swarm_uid].sort();

        const { data: inserted, error: insertError } = await admin
          .from("Matches")
          .insert({
            run_id: matchRun.id,
            swarm_a: swarmA,
            swarm_b: swarmB,
            raw_similarity: proposal.raw_similarity,
            display_score: score,
            component_scores: proposal.component_scores,
          })
          .select("id,display_score")
          .maybeSingle();

        if (inserted) {
          createdMatch = { id: inserted.id as string, display_score: score };
          break;
        }
        if (insertError && insertError.code !== "23505") throw new Error("MATCH_INSERT_FAILED");
        // 23505: para już istnieje (np. declined) — próbujemy kolejną propozycję.
      }
    }

    const finalStatus = createdMatch
      ? "matched"
      : decision === "INELIGIBLE"
        ? "ineligible"
        : "no_match";

    await admin
      .from("abacus_runs")
      .update({
        status: finalStatus,
        result_match_id: createdMatch?.id ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", run.id);

    if (createdMatch) {
      await admin.from("match_runs").update({ Matches_created: 1 }).eq("id", matchRun.id);
      const { data: matchRow, error: matchError } = await admin
        .from("Matches")
        .select("swarm_a,swarm_b")
        .eq("id", createdMatch.id)
        .single();
      if (matchError || !matchRow) throw new Error("MATCH_LOOKUP_FAILED");
      const userMap = await resolveUserIds(admin, [matchRow.swarm_a as string, matchRow.swarm_b as string]);
      const userIds = [...userMap.values()];
      if (userIds.length === 2) {
        await notifyMatch(admin, createdMatch.id, createdMatch.display_score, userIds);
      }
    }

    await admin.from("audit_log").insert({
      actor_type: "master_agent",
      action: `master_result_${finalStatus}`,
      subject_swarm_uid: source,
      payload_hash: await sha256Hex(runRef),
    });

    const { error: finishError } = await admin.rpc("fn_finish_swarm_event", {
      p_event_id: eventId,
      p_success: true,
      p_error_code: null,
    });
    if (finishError) console.error("fn_finish_swarm_event_failed", { code: finishError.code });

    return jsonResponse({ ok: true, status: finalStatus, match_id: createdMatch?.id ?? null });
  } catch (error) {
    console.error("abacus_match_callback_failed", {
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
    return errorResponse("CALLBACK_PROCESSING_FAILED", 500);
  }
});

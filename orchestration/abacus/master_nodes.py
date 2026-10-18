"""AI Swarm-Match / Master Swat Agent — węzły Abacus AI Workflow.

Każda funkcja węzła jest SAMODZIELNA (importy wewnątrz), bo Abacus serializuje
kod funkcji i wykonuje go w izolacji. Węzły nie używają LLM ani RAG:
dopasowanie 32-wektorów jest deterministyczną matematyką.

Izolacja sekretów:
- fetch_candidate_bundle: wyłącznie SWARM_CANDIDATES_URL + SWARM_SHARED_SECRET
- filter/score: brak sieci, brak sekretów (wektory wyłącznie w pamięci węzła)
- callback_result: wyłącznie SWARM_CALLBACK_URL + SWARM_SHARED_SECRET

Nigdzie nie wolno logować bundla ani wektorów.
"""

MASTER_VERSION = "master-v1.0"


def intake(event_id, event_type, swarm_uid, vector_version, idempotency_key, issued_at):
    """Węzeł 0: walidacja zdarzenia z Supabase (sam UID, bez wektora)."""
    import json
    import re
    from abacusai import AgentResponse

    uuid_re = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    if not uuid_re.match(str(event_id)) or not uuid_re.match(str(swarm_uid)):
        raise ValueError("invalid_uuid")
    if vector_version != "vec-v1":
        raise ValueError("unsupported_vector_version")
    if event_type not in ("VECTOR_READY", "VECTOR_UPDATED", "POS_PASSED", "PROFILE_READY"):
        raise ValueError("unsupported_event_type")
    if not idempotency_key or len(str(idempotency_key)) > 200:
        raise ValueError("invalid_idempotency_key")

    event = {
        "event_id": str(event_id),
        "event_type": str(event_type),
        "swarm_uid": str(swarm_uid),
        "vector_version": str(vector_version),
        "idempotency_key": str(idempotency_key),
        "issued_at": str(issued_at),
    }
    return AgentResponse(event_json=json.dumps(event, separators=(",", ":"), sort_keys=True))


def fetch_candidate_bundle(event_json):
    """Węzeł A: pobiera z Supabase bundle źródło+top kandydaci po pgvector ANN.

    Jedyny węzeł z dostępem do endpointu kandydatów. Podpis HMAC-SHA256
    liczony na: timestamp + '.' + raw_body. Supabase odrzuca odchyłkę czasu > 300 s.
    """
    import hashlib
    import hmac
    import json
    import time

    import requests
    from abacusai import AgentResponse, ApiClient

    event = json.loads(event_json)
    client = ApiClient()
    url = client.get_organization_secret("SWARM_CANDIDATES_URL").value
    secret = client.get_organization_secret("SWARM_SHARED_SECRET").value

    body = json.dumps(
        {"swarm_uid": event["swarm_uid"], "limit": 200, "event_id": event["event_id"]},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    timestamp = str(int(time.time()))
    signature = hmac.new(
        secret.encode("utf-8"), f"{timestamp}.".encode("utf-8") + body, hashlib.sha256
    ).hexdigest()

    response = requests.post(
        url,
        data=body,
        headers={
            "content-type": "application/json",
            "x-swarm-timestamp": timestamp,
            "x-swarm-signature": signature,
        },
        timeout=(3, 20),
    )
    if response.status_code != 200:
        raise RuntimeError(f"candidate_fetch_http_{response.status_code}")
    return AgentResponse(bundle_json=response.text)


def filter_candidates(bundle_json):
    """Węzeł B: twarde bramki przed cosinusem. Zero sieci, zero LLM.

    Odrzuca: zły kształt wektora, overlap twardych wymiarów < 24, brak wspólnego
    języka, niezgodność regionu/pasm wieku w którąkolwiek stronę, dealbreakery.
    """
    import json
    import math

    from abacusai import AgentResponse

    bundle = json.loads(bundle_json)
    source = bundle.get("source") or {}
    candidates = bundle.get("candidates") or []
    eligible = bool(bundle.get("source_eligible")) and not bundle.get("error")

    def valid_vector(values):
        return (
            isinstance(values, list)
            and len(values) == 32
            and all(isinstance(v, (int, float)) and math.isfinite(float(v)) and -1.0 <= float(v) <= 1.0 for v in values)
        )

    def mask_indices(mask):
        if not isinstance(mask, str) or len(mask) != 32 or any(ch not in "01" for ch in mask):
            return set()
        return {i for i, ch in enumerate(mask) if ch == "1"}  # pozycja od lewej = wymiar

    def valid_profile(profile):
        return (
            valid_vector(profile.get("embedding"))
            and len(mask_indices(profile.get("coverage_mask", ""))) >= 24
            and float(profile.get("confidence", 0)) >= 0.5
        )

    def region_parts(code):
        return str(code or "").split("-")

    def region_ok(scope, own_region, other_region):
        if scope == "anywhere":
            return True
        if not own_region or not other_region:
            return False
        a, b = region_parts(own_region), region_parts(other_region)
        if scope == "same_city":
            return a == b
        if scope == "same_voivodeship":
            return a[:2] == b[:2]
        if scope == "same_country":
            return a[:1] == b[:1]
        return False

    def opposite(a, b, dim, threshold):
        x, y = float(a["embedding"][dim]), float(b["embedding"][dim])
        return (x >= threshold and y <= -threshold) or (y >= threshold and x <= -threshold)

    filtered = []
    rejected = {"shape": 0, "overlap": 0, "language": 0, "region_age": 0, "dealbreaker": 0}

    if eligible and valid_profile(source):
        source_mask = mask_indices(source["coverage_mask"])
        source_constraints = source.get("constraints") or {}
        for candidate in candidates:
            if not valid_profile(candidate):
                rejected["shape"] += 1
                continue

            overlap = source_mask & mask_indices(candidate["coverage_mask"])
            category_minimums = (
                (set(range(0, 5)), 5),
                (set(range(5, 11)), 3),
                (set(range(11, 17)), 3),
                (set(range(17, 32)), 8),
            )
            if len(overlap) < 24 or any(len(overlap & dims) < minimum for dims, minimum in category_minimums):
                rejected["overlap"] += 1
                continue

            candidate_constraints = candidate.get("constraints") or {}
            if not (set(source_constraints.get("languages") or []) & set(candidate_constraints.get("languages") or [])):
                rejected["language"] += 1
                continue

            def age_ok(wanter_constraints, other):
                desired = wanter_constraints.get("desired_age_bands") or []
                return not desired or other.get("age_band") in desired

            if not (
                region_ok(source_constraints.get("max_region_scope"), source.get("region_code"), candidate.get("region_code"))
                and region_ok(candidate_constraints.get("max_region_scope"), candidate.get("region_code"), source.get("region_code"))
                and age_ok(source_constraints, candidate)
                and age_ok(candidate_constraints, source)
            ):
                rejected["region_age"] += 1
                continue

            dealbreakers_hit = False
            for constraints in (source_constraints, candidate_constraints):
                db = constraints.get("dealbreakers") or {}
                if db.get("intent_mismatch_hard") and opposite(source, candidate, 0, 0.5):
                    dealbreakers_hit = True
                if db.get("longterm_plan_conflict_hard") and opposite(source, candidate, 3, 0.6):
                    dealbreakers_hit = True
                if db.get("alcohol_mismatch_hard") and opposite(source, candidate, 22, 0.7):
                    dealbreakers_hit = True
                if db.get("pets_mismatch_hard") and opposite(source, candidate, 28, 0.7):
                    dealbreakers_hit = True
            if dealbreakers_hit:
                rejected["dealbreaker"] += 1
                continue

            candidate["_overlap_dimensions"] = len(overlap)
            filtered.append(candidate)
    else:
        eligible = False

    return AgentResponse(
        source_json=json.dumps(source, separators=(",", ":"), sort_keys=True),
        filtered_candidates_json=json.dumps(filtered, separators=(",", ":"), sort_keys=True),
        candidates_seen=len(candidates),
        source_eligible=eligible,
        rejected_json=json.dumps(rejected, separators=(",", ":"), sort_keys=True),
    )


def score_candidates(source_json, filtered_candidates_json, candidates_seen, source_eligible):
    """Węzeł C: maskowany, ważony cosinus 1-na-1 na kategoriach wymiarów.

    S = 0.30·intent(0-4) + 0.25·values(5-10) + 0.25·communication(11-16)
      + 0.20·lifestyle(17-31). Próg 0.78; wynik UI 80..99 (100 nieosiągalne).
    """
    import json
    import math
    import uuid
    from datetime import datetime, timezone

    from abacusai import AgentResponse

    source = json.loads(source_json) if source_json else {}
    candidates = json.loads(filtered_candidates_json) if filtered_candidates_json else []

    def mask_indices(mask):
        return {i for i, ch in enumerate(str(mask or "")) if ch == "1"}

    def masked_cosine(a, b, indices):
        dot = sum(float(a[i]) * float(b[i]) for i in indices)
        norm_a = math.sqrt(sum(float(a[i]) ** 2 for i in indices))
        norm_b = math.sqrt(sum(float(b[i]) ** 2 for i in indices))
        if norm_a == 0.0 or norm_b == 0.0:
            return 0.0
        value = dot / (norm_a * norm_b)
        return max(-1.0, min(1.0, value))

    categories = {
        "intent": (list(range(0, 5)), 0.30),
        "values": (list(range(5, 11)), 0.25),
        "communication": (list(range(11, 17)), 0.25),
        "lifestyle": (list(range(17, 32)), 0.20),
    }

    ranked = []
    if source_eligible and source.get("embedding"):
        source_vector = source["embedding"]
        source_mask = mask_indices(source.get("coverage_mask"))
        for candidate in candidates:
            candidate_vector = candidate["embedding"]
            overlap = source_mask & mask_indices(candidate.get("coverage_mask"))
            components = {}
            weighted_sum = 0.0
            for name, (indices, weight) in categories.items():
                shared = [i for i in indices if i in overlap]
                components[name] = masked_cosine(source_vector, candidate_vector, shared)
                weighted_sum += weight * components[name]

            similarity = max(-1.0, min(1.0, weighted_sum))
            ranked.append(
                {
                    "candidate_swarm_uid": candidate["swarm_uid"],
                    "raw_similarity": round(similarity, 6),
                    "display_score": (
                        min(99, int(round(80 + 20.0 * (similarity - 0.78) / 0.22)))
                        if similarity >= 0.78
                        else None
                    ),
                    "component_scores": {k: round(v, 6) for k, v in components.items()},
                    "overlap_dimensions": int(candidate.get("_overlap_dimensions") or len(overlap)),
                    "_tiebreak_confidence": float(candidate.get("confidence", 0)),
                }
            )

    ranked.sort(key=lambda row: (-row["raw_similarity"], -row["_tiebreak_confidence"], row["candidate_swarm_uid"]))
    best_similarity = ranked[0]["raw_similarity"] if ranked else None
    proposals = [
        {key: value for key, value in row.items() if not key.startswith("_")}
        for row in ranked
        if row["raw_similarity"] >= 0.78
    ][:3]

    if not source_eligible:
        decision = "INELIGIBLE"
    elif proposals:
        decision = "MATCHED"
    else:
        decision = "NO_MATCH"

    result = {
        "schema": "master-result-v1",
        "run_ref": str(uuid.uuid4()),
        "master_version": "master-v1.0",
        "source_swarm_uid": source.get("swarm_uid"),
        "decision": decision,
        "candidates_seen": int(candidates_seen or 0),
        "candidates_scored": len(ranked),
        "best_similarity": best_similarity,
        "proposals": proposals,
        "completed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    return AgentResponse(result_json=json.dumps(result, separators=(",", ":"), sort_keys=True))


def callback_result(event_json, result_json):
    """Węzeł D: jedyny powrót do Supabase. Dostaje wynik bez wektorów.

    Supabase po stronie callbacku PONOWNIE sprawdza eligibilność pary
    (PoS/blokady/pauza mogły się zmienić w trakcie runu) i dopiero zapisuje match.
    """
    import hashlib
    import hmac
    import json
    import time

    import requests
    from abacusai import AgentResponse, ApiClient

    event = json.loads(event_json)
    result = json.loads(result_json)
    result["event_id"] = event["event_id"]

    client = ApiClient()
    url = client.get_organization_secret("SWARM_CALLBACK_URL").value
    secret = client.get_organization_secret("SWARM_SHARED_SECRET").value

    body = json.dumps(result, separators=(",", ":"), sort_keys=True).encode("utf-8")
    timestamp = str(int(time.time()))
    signature = hmac.new(
        secret.encode("utf-8"), f"{timestamp}.".encode("utf-8") + body, hashlib.sha256
    ).hexdigest()

    response = requests.post(
        url,
        data=body,
        headers={
            "content-type": "application/json",
            "x-swarm-timestamp": timestamp,
            "x-swarm-signature": signature,
        },
        timeout=(3, 20),
    )
    if response.status_code not in (200, 202):
        raise RuntimeError(f"callback_http_{response.status_code}")

    return AgentResponse(decision=result["decision"], callback_status="acked")

"""Buduje graf Master Swat Agenta w Abacus.ai.

Użycie:
  python build_workflow.py            # tylko lokalna konstrukcja + podgląd grafu (bez sieci)
  python build_workflow.py --validate # dodatkowo client.validate_workflow_graph (wymaga ABACUS_API_KEY)
  python build_workflow.py --create   # tworzy agenta w projekcie ABACUS_PROJECT_ID

Po utworzeniu: w Abacus UI utwórz Online Deployment tego agenta i pobierz
deploymentId + deploymentToken z „Predictions API” — trafiają do sekretów
Supabase Edge Function `swarm-dispatch`, NIGDY do aplikacji mobilnej.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from abacusai import (  # noqa: E402
    AgentInterface,
    ApiClient,
    WorkflowGraph,
    WorkflowGraphNode,
    WorkflowNodeInputSchema,
)

from master_nodes import (  # noqa: E402
    callback_result,
    fetch_candidate_bundle,
    filter_candidates,
    intake,
    score_candidates,
)

INTAKE_INPUT_SCHEMA = WorkflowNodeInputSchema(
    json_schema={
        "type": "object",
        "title": "Swarm Event (Supabase -> Abacus)",
        "required": ["event_id", "event_type", "swarm_uid", "vector_version", "idempotency_key", "issued_at"],
        "properties": {
            "event_id": {"type": "string", "title": "event_id (uuid z swarm_events_outbox)"},
            "event_type": {"type": "string", "title": "VECTOR_READY | VECTOR_UPDATED | POS_PASSED | PROFILE_READY"},
            "swarm_uid": {"type": "string", "title": "swarm_uid źródła (bez wektora w zdarzeniu)"},
            "vector_version": {"type": "string", "title": "vec-v1"},
            "idempotency_key": {"type": "string", "title": "klucz idempotencji outboxa"},
            "issued_at": {"type": "string", "title": "ISO-8601 UTC"},
        },
    },
    ui_schema={},
)


def build_graph() -> WorkflowGraph:
    intake_node = WorkflowGraphNode(
        "0 Intake",
        intake,
        input_schema=INTAKE_INPUT_SCHEMA,
        output_mappings=["event_json"],
    )
    fetch_node = WorkflowGraphNode(
        "A FetchCandidateBundle",
        fetch_candidate_bundle,
        input_mappings={"event_json": intake_node.outputs.event_json},
        output_mappings=["bundle_json"],
    )
    filter_node = WorkflowGraphNode(
        "B EligibilityDealbreakerFilter",
        filter_candidates,
        input_mappings={"bundle_json": fetch_node.outputs.bundle_json},
        output_mappings=[
            "source_json",
            "filtered_candidates_json",
            "candidates_seen",
            "source_eligible",
            "rejected_json",
        ],
    )
    score_node = WorkflowGraphNode(
        "C CosineReranker",
        score_candidates,
        input_mappings={
            "source_json": filter_node.outputs.source_json,
            "filtered_candidates_json": filter_node.outputs.filtered_candidates_json,
            "candidates_seen": filter_node.outputs.candidates_seen,
            "source_eligible": filter_node.outputs.source_eligible,
        },
        output_mappings=["result_json"],
    )
    callback_node = WorkflowGraphNode(
        "D CallbackToSupabase",
        callback_result,
        input_mappings={
            "event_json": intake_node.outputs.event_json,
            "result_json": score_node.outputs.result_json,
        },
        output_mappings=["decision", "callback_status"],
    )

    return WorkflowGraph(
        nodes=[intake_node, fetch_node, filter_node, score_node, callback_node],
        primary_start_node=intake_node,
        specification_type="data_flow",
    )


REQUIRED_ORG_SECRETS = (
    "SWARM_CANDIDATES_URL",  # https://<project-ref>.supabase.co/functions/v1/swarm-candidates
    "SWARM_CALLBACK_URL",    # https://<project-ref>.supabase.co/functions/v1/abacus-match-callback
    "SWARM_SHARED_SECRET",   # min. 32 losowe bajty; ta sama wartość w sekretach Supabase
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validate", action="store_true")
    parser.add_argument("--create", action="store_true")
    parser.add_argument("--name", default="AI Swarm-Match / Master Swat Agent")
    args = parser.parse_args()

    graph = build_graph()
    preview = {
        "nodes": [node.name for node in graph.nodes],
        "specification_type": graph.specification_type,
        "required_org_secrets": list(REQUIRED_ORG_SECRETS),
    }
    print(json.dumps(preview, indent=2, ensure_ascii=False))

    if not (args.validate or args.create):
        print("Tryb lokalny: graf zbudowany, brak wywołań sieciowych.")
        return 0

    api_key = os.environ.get("ABACUS_API_KEY")
    if not api_key:
        raise SystemExit("Brak ABACUS_API_KEY w środowisku.")
    client = ApiClient(api_key)

    if args.validate:
        result = client.validate_workflow_graph(
            workflow_graph=graph,
            agent_interface=AgentInterface.DEFAULT,
            package_requirements=["requests"],
        )
        print("validate_workflow_graph:", result)

    if args.create:
        project_id = os.environ.get("ABACUS_PROJECT_ID")
        if not project_id:
            raise SystemExit("Brak ABACUS_PROJECT_ID w środowisku.")
        agent = client.create_agent(
            project_id=project_id,
            name=args.name,
            workflow_graph=graph,
            agent_interface=AgentInterface.DEFAULT,
            package_requirements=["requests"],
            description=(
                "Deterministyczny reranking 32-wektorów psychometrycznych. "
                "Bez RAG, bez zapisu wektorów, bez logowania payloadów."
            ),
        )
        agent.wait_for_publish()
        print("agent_id:", getattr(agent, "agent_id", agent))
        print(
            "Następny krok (Abacus UI): Online Deployment -> Predictions API -> "
            "deploymentId + deploymentToken do sekretów Supabase swarm-dispatch."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

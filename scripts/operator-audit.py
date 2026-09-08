"""Bounded Phoenix query -> candidate audit signals; never an automatic verdict.

No local transcript parser or new database. Phoenix's native SDK supplies spans.
Use the native px/MCP clients for trace inspection, annotations and experiments.
"""
import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime


def same_measurement(left, right):
    """JSON measurement equality must not equate booleans, integers and floats."""
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            same_measurement(left[key], right[key]) for key in left
        )
    if isinstance(left, (list, tuple)):
        return len(left) == len(right) and all(
            same_measurement(a, b) for a, b in zip(left, right)
        )
    return left == right


def tool_measurements():
    return {"calls":0, "mcp_errors":0, "nonzero_process_exits":0,
            "returned_bytes":0, "duration_ms":0,
            "measurement_coverage":{
                key:{"observed":0,"missing":0,"invalid":0}
                for key in ("process_exit", "returned_bytes", "duration_ms")
            }}


def summarize(spans, limit, include_synthetic=False):
    selected = [s for s in spans if include_synthetic or not str(s.get("attributes", {}).get("session.id", "")).startswith("synthetic-")]
    by_tool = defaultdict(tool_measurements)
    repeated = Counter()
    examples = []
    seen = {}
    conflicts = set()
    duplicate_records = 0
    invalid_identities = 0
    invalid_measurements = 0
    non_invocations = 0
    session_attribution = {"observed":0, "missing":0}
    codex_events = defaultdict(lambda: {"event_occurrences":0, "success_true":0, "success_false":0, "success_unobserved":0})
    for s in selected:
        context = s.get("context", {})
        identity = (context.get("trace_id"), context.get("span_id"))
        if not all(isinstance(part,str) and part for part in identity):
            invalid_identities += 1
            continue
        if identity in seen:
            duplicate_records += 1
            # Annotation/API metadata may change without changing the measured
            # span. Conflicting measurements are excluded, not first-copy-wins.
            fields = ("name", "attributes", "events", "start_time", "end_time", "status_code")
            if any(not same_measurement(s.get(field), seen[identity].get(field)) for field in fields):
                conflicts.add(identity)
            continue
        seen[identity] = s
    for identity, s in seen.items():
        if identity in conflicts:
            continue
        a = s.get("attributes", {})
        session = a.get("session.id")
        session_attribution["observed" if isinstance(session, str) and session else "missing"] += 1
        if a.get("zes.observation.boundary") == "codex_native_filtered":
            for event in s.get("events", []):
                ea = event.get("attributes", {})
                if ea.get("event.name") == "codex.tool_result":
                    event_tool = ea.get("tool_name") or "unattributed"
                    erow = codex_events[event_tool]
                    erow["event_occurrences"] += 1
                    success = ea.get("success")
                    erow["success_true" if success is True else "success_false" if success is False else "success_unobserved"] += 1
        tool = a.get("tool.name")
        if a.get("zes.observation.boundary") != "nexus_mcp_only" or not isinstance(tool, str) or not tool:
            non_invocations += 1
            continue
        row = by_tool[tool]
        row["calls"] += 1
        row["mcp_errors"] += a.get("zes.tool.outcome") in ("error", "blocked", "interrupted")
        coverage = row["measurement_coverage"]
        exit_code = a.get("zes.exitCode")
        if exit_code is None:
            coverage["process_exit"]["missing"] += 1
        elif type(exit_code) is not int:
            invalid_measurements += 1
            coverage["process_exit"]["invalid"] += 1
            exit_code = None
        else:
            coverage["process_exit"]["observed"] += 1
        nonzero = exit_code is not None and exit_code != 0
        row["nonzero_process_exits"] += nonzero
        returned = a.get("zes.outputDeltaBytes")
        if returned is None:
            coverage["returned_bytes"]["missing"] += 1
        elif type(returned) is int and returned >= 0:
            row["returned_bytes"] += returned
            coverage["returned_bytes"]["observed"] += 1
        else:
            invalid_measurements += 1
            coverage["returned_bytes"]["invalid"] += 1
        if s.get("start_time") is None or s.get("end_time") is None:
            coverage["duration_ms"]["missing"] += 1
        else:
            try:
                elapsed = (datetime.fromisoformat(s["end_time"])-datetime.fromisoformat(s["start_time"])).total_seconds()*1000
                if elapsed < 0:
                    raise ValueError("negative observed duration")
                row["duration_ms"] += elapsed
                coverage["duration_ms"]["observed"] += 1
            except (TypeError, ValueError):
                invalid_measurements += 1
                coverage["duration_ms"]["invalid"] += 1
        if a.get("zes.path_sha256"):
            repeated[(a.get("session.id", "unknown"), a["zes.path_sha256"])] += 1
        if nonzero or a.get("zes.tool.outcome") in ("error", "blocked", "interrupted"):
            examples.append({"trace_id":identity[0], "span_id":identity[1], "session":a.get("session.id"),
                             "tool":tool, "tool_outcome":a.get("zes.tool.outcome"), "process_exit":exit_code,
                             "task_outcome":"not_assessed"})
    for row in by_tool.values():
        for key in ("returned_bytes", "duration_ms"):
            if row["measurement_coverage"][key]["observed"] == 0:
                row[key] = None
    return {"retrieved":len(spans), "included_unique_spans":len(seen), "limit":limit,
            "invalid_span_identities":invalid_identities,
            "duplicate_span_records":duplicate_records,
            "conflicting_duplicate_spans":len(conflicts),
            "invalid_measurement_fields":invalid_measurements,
            "non_invocation_spans":non_invocations,
            "session_attribution":session_attribution,
            "synthetic_exclusion_meaning":"Only explicit synthetic- session labels are excluded; missing session identity does not establish real or synthetic origin",
            "by_tool_meaning":"Nexus MCP invocation spans with an explicit observation boundary only",
            "measurement_totals_meaning":"Sums cover observed valid samples only; null means no valid samples, not measured zero; coverage is per included invocation",
            "codex_tool_result_events":dict(codex_events),
            "codex_event_count_meaning":"Retained native event occurrences; nested exec layers are not independent commands; logs are not added",
            "window_may_be_truncated":len(spans)>=limit, "synthetic_included":include_synthetic,
            "by_tool":dict(by_tool), "repeated_path_candidates":[{"session":s,"path_sha256":p,"count":n} for (s,p),n in repeated.most_common(20) if n>1],
            "outcome_examples":examples[:30],
            "claim_ceiling":"Bounded observed activity and investigation candidates; not task success, wasted work, total spend or whole-system coverage",
            "deduplication":"trace_id + span_id within this response only; no cross-signal or backend exactly-once claim"}


def main():
    from phoenix.client import Client
    p = argparse.ArgumentParser()
    p.add_argument("--project", choices=["zes-operator-chatgpt", "zes-operator-codex"], required=True)
    p.add_argument("--limit", type=int, default=200)
    p.add_argument("--include-synthetic", action="store_true")
    a = p.parse_args()
    if not 1 <= a.limit <= 1000: p.error("limit must be between 1 and 1000")
    spans = Client(base_url="http://127.0.0.1:16006").spans.get_spans(project_identifier=a.project, limit=a.limit)
    print(json.dumps({"project":a.project, **summarize(spans, a.limit, a.include_synthetic)}, indent=2))


if __name__ == "__main__": main()

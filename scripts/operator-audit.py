"""Bounded Phoenix query -> candidate audit signals; never an automatic verdict.

No local transcript parser or new database. Phoenix's native SDK supplies spans.
Use the native px/MCP clients for trace inspection, annotations and experiments.
"""
import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime

def summarize(spans, limit, include_synthetic=False):
    selected = [s for s in spans if include_synthetic or not str(s.get("attributes", {}).get("session.id", "")).startswith("synthetic-")]
    by_tool = defaultdict(lambda: {"calls":0, "mcp_errors":0, "nonzero_process_exits":0, "returned_bytes":0, "duration_ms":0})
    repeated = Counter()
    examples = []
    seen = set()
    invalid_identities = 0
    for s in selected:
        a = s.get("attributes", {})
        context = s.get("context", {})
        identity = (context.get("trace_id"), context.get("span_id"))
        if not all(isinstance(part,str) and part for part in identity):
            invalid_identities += 1
            continue
        if identity in seen: continue
        seen.add(identity)
        tool = a.get("tool.name", s.get("name", "unknown"))
        row = by_tool[tool]
        row["calls"] += 1
        row["mcp_errors"] += a.get("zes.tool.outcome") in ("error", "blocked", "interrupted")
        nonzero = isinstance(a.get("zes.exitCode"), int) and a["zes.exitCode"] != 0
        row["nonzero_process_exits"] += nonzero
        row["returned_bytes"] += a.get("zes.outputDeltaBytes", 0)
        if s.get("start_time") and s.get("end_time"):
            row["duration_ms"] += (datetime.fromisoformat(s["end_time"])-datetime.fromisoformat(s["start_time"])).total_seconds()*1000
        if a.get("zes.path_sha256"):
            repeated[(a.get("session.id", "unknown"), a["zes.path_sha256"])] += 1
        if nonzero or a.get("zes.tool.outcome") in ("error", "blocked", "interrupted"):
            examples.append({"trace_id":identity[0], "span_id":identity[1], "session":a.get("session.id"),
                             "tool":tool, "tool_outcome":a.get("zes.tool.outcome"), "process_exit":a.get("zes.exitCode"),
                             "task_outcome":"not_assessed"})
    return {"retrieved":len(spans), "included_unique_spans":len(seen), "limit":limit,
            "invalid_span_identities":invalid_identities,
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

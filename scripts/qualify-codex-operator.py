"""One ephemeral native Codex run of an invented two-command task.

Does not change Codex configuration, read rollouts, or retain raw model events.
This is producer/pipeline qualification, never an ongoing worker wrapper.
"""
import argparse
import hashlib
import json
import os
import selectors
import signal
import subprocess
import tempfile
import time
from pathlib import Path

from phoenix.client import Client


def attrs(record):
    return {a["key"]: next(iter(a["value"].values()), None) for a in record.get("attributes", [])}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = {"synthetic_task":True, "native_codex_launches":0, "safe_cli_items":[], "ongoing_worker_enablement":False}
    config = Path.home()/".codex/config.toml"
    before = hashlib.sha256(config.read_bytes()).hexdigest()
    trace_file = Path("/var/lib/zes-operator-collector/traces.jsonl")
    log_file = Path("/var/lib/zes-operator-collector/logs.jsonl")
    offsets = {p:p.stat().st_size for p in [trace_file, log_file]}
    worker = None
    try:
        with tempfile.TemporaryDirectory(prefix="synthetic-codex-operator-") as folder:
            Path(folder,"task.py").write_text("import sys\nprint('ZES_OPERATOR_TOOL_CANARY')\nraise SystemExit(int(sys.argv[1]))\n")
            command = ["codex", "exec", "--ephemeral", "--skip-git-repo-check", "--json", "--sandbox", "read-only", "-C", folder,
                       "-c", 'approval_policy="never"', "-c", 'otel.log_user_prompt=false',
                       "-c", 'otel.environment="synthetic-operator-qualification"']
            for key, endpoint in [("exporter","logs"),("trace_exporter","traces"),("metrics_exporter","metrics")]:
                command += ["-c", f'otel.{key}={{otlp-http={{endpoint="http://127.0.0.1:14318/v1/{endpoint}",protocol="binary"}}}}']
            command += ["Run python3 task.py 7 once, then python3 task.py 0 once as separate shell tool calls. Do not read other paths or edit files. The first failure is an intentional measurement control, not a bug. Report only both exit codes. Prompt canary ZES_OPERATOR_PROMPT_CANARY."]
            worker = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
            report["native_codex_launches"] = 1
            selector = selectors.DefaultSelector()
            selector.register(worker.stdout, selectors.EVENT_READ)
            started = time.monotonic()
            while time.monotonic()-started < 240:
                for key,_ in selector.select(.2):
                    line = key.fileobj.readline()
                    if not line: selector.unregister(key.fileobj); continue
                    try: event = json.loads(line)
                    except ValueError: continue
                    if event.get("type") == "thread.started": report["native_thread_id"] = event.get("thread_id")
                    item = event.get("item") or {}
                    if event.get("type") == "item.completed" and item.get("type") == "command_execution":
                        report["safe_cli_items"].append({k:item.get(k) for k in ["type","status","exit_code"]})
                    if event.get("type") == "turn.completed": report["cli_usage"] = event.get("usage")
                    if event.get("type") in ("error","turn.failed"): report["native_failure_seen"] = True
                if worker.poll() is not None and not selector.get_map(): break
            report["native_exit"] = worker.poll()
            report["observed_seconds"] = time.monotonic()-started
            if worker.poll() is None: raise TimeoutError("Owned fixture exceeded its bound")
        assert report["native_exit"] == 0
        assert [x["exit_code"] for x in report["safe_cli_items"]] == [7,0]
        time.sleep(3)
        tail = {}
        for p, offset in offsets.items():
            with p.open("rb") as f: f.seek(offset); tail[p] = f.read().decode()
        assert all("ZES_OPERATOR_TOOL_CANARY" not in text and "ZES_OPERATOR_PROMPT_CANARY" not in text for text in tail.values())
        spans = []
        for line in tail[trace_file].splitlines():
            for resource in json.loads(line).get("resourceSpans",[]):
                for scope in resource.get("scopeSpans",[]): spans += scope.get("spans",[])
        candidates = [s for s in spans if any(attrs(e).get("event.name")=="codex.tool_result" for e in s.get("events",[]))]
        assert candidates, "No native tool-result trace events were persisted"
        chosen = candidates[-1]
        found = Client(base_url="http://127.0.0.1:16006").spans.get_spans(project_identifier="zes-operator-codex", span_ids=[chosen["spanId"]], limit=10)
        assert len(found)==1
        report.update({"native_tool_event_spans":len(candidates), "native_spans_in_window":len(spans),
                       "exact_phoenix_span_readback":found[0]["context"], "content_canaries_absent":True,
                       "tool_event_observations":[attrs(e) for s in candidates for e in s.get("events",[]) if attrs(e).get("event.name")=="codex.tool_result"],
                       "claim_ceiling":"One native Codex fixture through the operator receiver, not ongoing production tracing or billing reconciliation"})
    finally:
        if worker is not None and worker.poll() is None:
            os.killpg(worker.pid,signal.SIGTERM)
            try: worker.wait(timeout=10)
            except subprocess.TimeoutExpired: os.killpg(worker.pid,signal.SIGKILL); worker.wait(timeout=5)
        report["account_config_unchanged"] = before==hashlib.sha256(config.read_bytes()).hexdigest()
        report["owned_worker_terminal"] = worker is None or worker.poll() is not None
        args.output.write_text(json.dumps(report,indent=2)+"\n")
        print(json.dumps({k:v for k,v in report.items() if k not in ["native_thread_id","tool_event_observations"]}))


if __name__ == "__main__": main()

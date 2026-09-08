"""Exercise new local operator ingestion with synthetic content, not model work.

Uses native OTel protobufs and Phoenix Client. Never reads a real conversation.
Leaves an explicit synthetic session name in the two operator projects.
"""
import argparse
import json
import time
import uuid
from pathlib import Path

import httpx
from phoenix.client import Client
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest


def attr(target, key, value):
    a = target.add(key=key)
    if isinstance(value, bool): a.value.bool_value = value
    elif isinstance(value, int): a.value.int_value = value
    else: a.value.string_value = value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    seed = uuid.uuid4().hex
    sentinel = "ZES_PRIVATE_CANARY_" + seed
    session = "synthetic-operator-qualification-" + seed
    client = Client(base_url="http://127.0.0.1:16006")
    results = {}
    for lane, port, project in [("codex", 14318, "zes-operator-codex"), ("nexus", 14319, "zes-operator-chatgpt")]:
        req = ExportTraceServiceRequest()
        resource = req.resource_spans.add()
        attr(resource.resource.attributes, "service.name", "synthetic-operator-qualification")
        attr(resource.resource.attributes, "private.resource", sentinel)
        scope = resource.scope_spans.add()
        scope.scope.name = "synthetic.qualifier"
        span = scope.spans.add(name="mcp.synthetic_qualification" if lane == "nexus" else sentinel,
                              trace_id=uuid.uuid4().bytes, span_id=uuid.uuid4().bytes[:8],
                              start_time_unix_nano=time.time_ns(), end_time_unix_nano=time.time_ns()+1000)
        span.status.message = sentinel
        attr(span.attributes, "conversation.id" if lane == "codex" else "session.id", session)
        attr(span.attributes, "model", "synthetic-no-model")
        attr(span.attributes, "prompt", sentinel)
        attr(span.attributes, "output", sentinel)
        attr(span.attributes, "zes.exitCode", 7)
        attr(span.attributes, "openinference.span.kind", "TOOL")
        event = span.events.add(name=sentinel, time_unix_nano=time.time_ns())
        attr(event.attributes, "event.name", "codex.tool_result")
        attr(event.attributes, "output", sentinel)
        attr(event.attributes, "tool_name", "synthetic_tool")
        attr(event.attributes, "output_length", 12)
        trace_id, span_id = span.trace_id.hex(), span.span_id.hex()
        r = httpx.post(f"http://127.0.0.1:{port}/v1/traces", content=req.SerializeToString(), headers={"content-type":"application/x-protobuf"}, timeout=10)
        r.raise_for_status()
        found = []
        for _ in range(60):
            try:
                spans = client.spans.get_spans(project_identifier=project, limit=100)
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code != 404: raise
                spans = []
            found = [s for s in spans if s["context"]["span_id"] == span_id]
            if found: break
            time.sleep(.25)
        assert len(found) == 1, (lane, "exact newly submitted span not visible")
        assert sentinel not in json.dumps(found), (lane, "private canary survived")
        results[lane] = {"trace_id":trace_id, "span_id":span_id, "retrieved":True, "private_canary_absent":True, "span":found[0]}

    logs = ExportLogsServiceRequest()
    resource = logs.resource_logs.add()
    attr(resource.resource.attributes, "service.name", "synthetic-operator-qualification")
    attr(resource.resource.attributes, "secret.resource", sentinel)
    record = resource.scope_logs.add().log_records.add(time_unix_nano=time.time_ns())
    record.body.string_value = sentinel
    attr(record.attributes, "event.name", "codex.tool_result")
    attr(record.attributes, "conversation.id", session)
    attr(record.attributes, "output", sentinel)
    attr(record.attributes, "duration_ms", 17)
    response = httpx.post("http://127.0.0.1:14318/v1/logs", content=logs.SerializeToString(), headers={"content-type":"application/x-protobuf"}, timeout=10)
    response.raise_for_status()
    time.sleep(2)
    # Check the actual newly persisted native exporter files, not a claimed filter list.
    retained = Path("/var/lib/zes-operator-collector/logs.jsonl").read_text()
    traces = Path("/var/lib/zes-operator-collector/traces.jsonl").read_text()
    assert session in retained and session in traces
    assert sentinel not in retained and sentinel not in traces
    report = {"schema":"zes.operator.qualification.v1", "synthetic":True,
              "session":session, "lanes":results, "private_canary_absent_from_native_files":True,
              "host_block_rate_measured":False, "model_invocations":0}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps({"status":"synthetic_ingestion_and_privacy_pass", "session":session,
                      "exact_spans_read_back":2, "report":str(args.output)}))


if __name__ == "__main__": main()

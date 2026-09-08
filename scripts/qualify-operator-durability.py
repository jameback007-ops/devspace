"""Fault-inject a disposable native Collector; never touch live producers/services.

The sink is a protocol fixture, not Phoenix and not an alternative telemetry
backend. Each invocation uses new identities, ports and private storage. An HTTP
success is checked against exact span IDs after SIGKILL, not inferred from WAL
configuration. Requires PyYAML and opentelemetry-proto in the operator environment.
"""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import json
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yaml
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest, ExportTraceServiceResponse

CANARY = "OPERATOR_DURABILITY_PRIVATE_SENTINEL"


def port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for(predicate, timeout: float = 10) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class Sink(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Handler)
        self.lock = threading.Lock()
        self.mode = "unavailable"
        self.received: list[str] = []
        self.projects: set[str] = set()
        self.private_leak = False
        self.attempts = 0
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def ids(self) -> list[str]:
        with self.lock:
            return list(self.received)

    def set_mode(self, mode: str) -> None:
        with self.lock:
            self.mode = mode

    def close(self) -> None:
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=2)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        data = ExportTraceServiceRequest.FromString(body)
        sink = self.server
        with sink.lock:
            sink.attempts += 1
            mode = sink.mode
            if mode != "unavailable":
                sink.private_leak |= CANARY.encode() in data.SerializeToString()
                for resource in data.resource_spans:
                    for attribute in resource.resource.attributes:
                        if attribute.key == "openinference.project.name":
                            sink.projects.add(attribute.value.string_value)
                    for scope in resource.scope_spans:
                        sink.received.extend(span.span_id.hex() for span in scope.spans)
            if mode == "lose_ack":
                sink.mode = "ok"
        if mode == "lose_ack":
            # Delivery happened but its acknowledgement is lost. Native retry
            # must keep the same identities; this is not a second command.
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        self.send_response(503 if mode == "unavailable" else 200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.send_header("Content-Length", "0")
        self.end_headers()


def fixture(lane: str, count: int) -> tuple[bytes, list[str]]:
    request = ExportTraceServiceRequest()
    resource = request.resource_spans.add()
    resource.resource.attributes.add(key="service.name").value.string_value = "durability-fixture"
    resource.resource.attributes.add(key="private").value.string_value = CANARY
    scope = resource.scope_spans.add()
    scope.scope.name = "operator.durability.synthetic"
    ids = []
    for _ in range(count):
        span = scope.spans.add()
        span.trace_id = uuid.uuid4().bytes
        span.span_id = uuid.uuid4().bytes[:8]
        ids.append(span.span_id.hex())
        span.name = "mcp.synthetic_durability"
        span.start_time_unix_nano = time.time_ns()
        span.end_time_unix_nano = span.start_time_unix_nano + 1000
        span.attributes.add(key="private").value.string_value = CANARY
        span.attributes.add(key="session.id").value.string_value = "synthetic-durability"
        if lane == "codex":
            span.attributes.add(key="conversation.id").value.string_value = "synthetic-durability"
            event = span.events.add(name="original")
            event.attributes.add(key="event.name").value.string_value = "codex.tool_result"
            event.attributes.add(key="output").value.string_value = CANARY
    return request.SerializeToString(), ids


def submit(endpoint: int, data: bytes) -> int:
    req = urllib.request.Request(f"http://127.0.0.1:{endpoint}/v1/traces", data=data,
                                 headers={"Content-Type": "application/x-protobuf"})
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            reply = ExportTraceServiceResponse.FromString(response.read())
            if reply.partial_success.rejected_spans:
                raise AssertionError("Partial OTLP rejection must not be counted as full acceptance")
            return response.status
    except urllib.error.HTTPError as error:
        error.read()
        return error.code


class Collector:
    def __init__(self, binary: Path, config: dict, root: Path):
        self.binary, self.root = binary, root
        self.path = root / "collector.yaml"
        self.path.write_text(yaml.safe_dump(config, sort_keys=False))
        self.process = None
        self.log = (root / "collector.log").open("ab")
        self.health = config["extensions"]["health_check"]["endpoint"]
        validation = subprocess.run([str(binary), "validate", "--config", str(self.path)],
                                    stdout=self.log, stderr=self.log, timeout=15)
        if validation.returncode:
            raise RuntimeError(f"Native config validation failed: {self.path}")

    def start(self):
        self.process = subprocess.Popen([str(self.binary), "--config", str(self.path)],
                                        stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
        def ready():
            if self.process.poll() is not None:
                raise RuntimeError(f"Owned Collector exited: {self.root}")
            try:
                with urllib.request.urlopen(f"http://{self.health}/", timeout=0.2) as response:
                    return response.status == 200
            except (OSError, urllib.error.URLError):
                return False
        if not wait_for(ready):
            raise TimeoutError("Owned Collector not ready")

    def kill(self):
        if self.process and self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=5)

    def close(self):
        self.kill()
        self.log.close()


def configuration(source: dict, root: Path, sink: Sink, scenario: str) -> tuple[dict, dict]:
    config = copy.deepcopy(source)
    ports = {lane: port() for lane in ("codex", "nexus")}
    for lane, value in ports.items():
        config["receivers"][f"otlp/{lane}"]["protocols"]["http"]["endpoint"] = f"127.0.0.1:{value}"
    config["extensions"]["health_check"]["endpoint"] = f"127.0.0.1:{port()}"
    config["extensions"]["file_storage"]["directory"] = str(root / "queue")
    exporter = config["exporters"]["otlp_http/phoenix"]
    exporter["endpoint"] = f"http://127.0.0.1:{sink.server_port}"
    # Source minimizers and pipeline order are unmodified. Only exact resource
    # locations and, for overflow, the intentionally tiny queue are substituted.
    if scenario == "overflow":
        exporter["sending_queue"].update(queue_size=2, num_consumers=1)
    for name in ("logs", "traces", "metrics"):
        config["exporters"][f"file/{name}"]["path"] = str(root / f"{name}.jsonl")
    config["service"]["telemetry"]["metrics"]["readers"][0]["pull"]["exporter"]["prometheus"]["port"] = port()
    return config, ports


def run(source: dict, binary: Path, root: Path, scenario: str, expect_loss: bool) -> dict:
    root.mkdir(mode=0o700)
    sink = Sink()
    collector = None
    report = {"scenario": scenario, "synthetic_only": True, "rejected": 0}
    try:
        config, ports = configuration(source, root, sink, scenario)
        collector = Collector(binary, config, root)
        collector.start()
        acknowledged = []
        if scenario == "duplicate":
            sink.set_mode("lose_ack")
        started = time.monotonic()
        for index in range(8 if scenario == "overflow" else 2):
            lane = "codex" if index % 2 else "nexus"
            body, ids = fixture(lane, 3)
            status = submit(ports[lane], body)
            if status == 200:
                acknowledged.extend(ids)
            else:
                report["rejected"] += len(ids)
        report["acknowledged_span_count"] = len(acknowledged)
        report["submission_seconds"] = time.monotonic() - started
        if scenario == "outage":
            assert wait_for(lambda: sink.attempts >= 2), "Native retry was not exercised"
            report["unavailable_attempts"] = sink.attempts
            sink.set_mode("ok")
        if scenario in ("restart", "overflow"):
            collector.kill()
            report["killed_after_ack_seconds"] = time.monotonic() - started
            report["canary_absent_from_wal"] = all(
                CANARY.encode() not in path.read_bytes() for path in (root / "queue").glob("*") if path.is_file())
            sink.set_mode("ok")
            collector.start()  # same native WAL; no source/request replay
        wanted = set(acknowledged)
        recovered = wait_for(lambda: wanted.issubset(sink.ids()), timeout=4 if expect_loss else 10)
        if scenario == "duplicate":
            wait_for(lambda: len(sink.ids()) > len(set(sink.ids())), timeout=5)
        counts = Counter(sink.ids())
        report.update(recovered_span_count=len(wanted.intersection(counts)),
                      missing_span_ids=sorted(wanted.difference(counts)),
                      delivery_count=sum(counts.values()), distinct_span_count=len(counts),
                      duplicate_deliveries=sum(counts.values()) - len(counts),
                      source_projects=sorted(sink.projects),
                      downstream_attempts=sink.attempts,
                      content_canary_absent=not sink.private_leak)
        if expect_loss:
            assert scenario == "restart" and not recovered, "Expected baseline loss was not reproduced"
        else:
            assert recovered, report
            assert not sink.private_leak, "Minimization failed"
            assert report.get("canary_absent_from_wal", True), "Private data in WAL"
            if scenario == "overflow":
                assert report["rejected"] > 0, "Small queue did not exercise overflow"
            if scenario == "duplicate":
                assert report["duplicate_deliveries"] > 0, "Lost acknowledgement did not exercise retry"
        report["assertions_passed"] = True
        return report
    finally:
        if collector:
            collector.close()
        sink.close()
        report["owned_process_terminal"] = collector is None or collector.process is None or collector.process.poll() is not None
        (root / "report.json").write_text(json.dumps(report, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collector", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expect-baseline-loss", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    source = yaml.safe_load(args.config.read_text())
    report = {"source_config_sha256": hashlib.sha256(args.config.read_bytes()).hexdigest(),
              "collector_sha256": hashlib.sha256(args.collector.read_bytes()).hexdigest(),
              "collector_version": subprocess.check_output([str(args.collector), "--version"], text=True).strip(),
              "claim_ceiling": "Native Collector synthetic fault tests, not Phoenix deployment, power-loss or continuous producer qualification",
              "cases": []}
    try:
        for scenario in (["restart"] if args.expect_baseline_loss else ["restart", "outage", "overflow", "duplicate"]):
            report["cases"].append(run(source, args.collector, args.output / scenario, scenario, args.expect_baseline_loss))
    finally:
        (args.output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()

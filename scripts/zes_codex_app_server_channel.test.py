#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import queue
import sys
import threading
import time
import unittest
from typing import Any


SCRIPT = Path(__file__).with_name("zes_codex_app_server_channel.py")
SPEC = importlib.util.spec_from_file_location("zes_codex_channel_tested", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
channel_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = channel_module
SPEC.loader.exec_module(channel_module)


class FakeRpcError(RuntimeError):
    def __init__(self, method: str, error: object) -> None:
        super().__init__(f"{method} failed: {json.dumps(error, sort_keys=True)}")
        self.method = method
        self.error = error


class FakeRelay:
    RpcError = FakeRpcError


class _Disconnect:
    def __init__(self, error: BaseException | None = None) -> None:
        self.error = error or OSError("fake channel disconnected")


class FakeTransportState:
    def __init__(self) -> None:
        self.incoming: queue.Queue[dict[str, Any] | _Disconnect] = queue.Queue()
        self.sent: list[dict[str, Any]] = []
        self.sent_condition = threading.Condition()
        self.connections = 0
        self.closed = 0
        self.socket_timeouts: list[float | None] = []
        self.socket_shutdowns = 0
        self.on_send: Any = None

    def wait_for_sent(
        self,
        predicate: Any,
        *,
        timeout: float = 2.0,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        with self.sent_condition:
            while True:
                for value in self.sent:
                    if predicate(value):
                        return value
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AssertionError(f"timed out waiting for sent frame: {self.sent!r}")
                self.sent_condition.wait(timeout=remaining)


class FakeSocket:
    def __init__(self, state: FakeTransportState) -> None:
        self.state = state

    def settimeout(self, value: float | None) -> None:
        self.state.socket_timeouts.append(value)

    def shutdown(self, _how: int) -> None:
        self.state.socket_shutdowns += 1


class FakeTransport:
    def __init__(
        self,
        _socket_path: Path,
        _timeout_seconds: float,
        state: FakeTransportState,
    ) -> None:
        self.state = state
        self.entered = False
        self.sock = FakeSocket(state)

    def __enter__(self) -> "FakeTransport":
        self.entered = True
        self.state.connections += 1
        return self

    def __exit__(self, *_args: object) -> None:
        if self.entered:
            self.entered = False
            self.state.closed += 1
            self.state.incoming.put(_Disconnect())

    def initialize(self) -> dict[str, object]:
        return {
            "userAgent": "codex-app-server-test",
            "platformFamily": "unix",
            "platformOs": "linux",
        }

    def _send_json(self, value: dict[str, Any]) -> None:
        copied = json.loads(json.dumps(value))
        with self.state.sent_condition:
            self.state.sent.append(copied)
            self.state.sent_condition.notify_all()
        callback = self.state.on_send
        if callback is not None:
            callback(copied)

    def _recv_json(self) -> dict[str, Any]:
        value = self.state.incoming.get(timeout=5)
        if isinstance(value, _Disconnect):
            raise value.error
        return value


def notification_projector(
    method: str,
    params: dict[str, Any],
    _generation: int,
) -> dict[str, Any] | None:
    if method.startswith("item/reasoning/"):
        return None
    return {
        "kind": "native_notification",
        "method": method,
        "sessionRef": params.get("safeSessionRef"),
        "turnRef": params.get("safeTurnRef"),
        "paramsDigestSha256": channel_module._digest(params),
    }


def server_request_projector(
    method: str,
    params: dict[str, Any],
    _generation: int,
) -> dict[str, Any]:
    return {
        "kind": {
            "item/commandExecution/requestApproval": "command_approval",
            "item/fileChange/requestApproval": "file_change_approval",
            "item/tool/requestUserInput": "user_input",
            "mcpServer/elicitation/request": "mcp_elicitation",
            "item/permissions/requestApproval": "permission_approval",
            "applyPatchApproval": "legacy_patch_approval",
            "execCommandApproval": "legacy_command_approval",
        }[method],
        "sessionRef": params.get("safeSessionRef"),
        "turnRef": params.get("safeTurnRef"),
        "itemRef": params.get("safeItemRef"),
        "summary": "bounded safe projection",
        "requestDigestSha256": channel_module._digest(params),
    }


class CodexAppServerChannelTests(unittest.TestCase):
    def setUp(self) -> None:
        self.state = FakeTransportState()

        def factory(path: Path, timeout: float) -> FakeTransport:
            return FakeTransport(path, timeout, self.state)

        self.channel = channel_module.CodexAppServerChannel(
            relay_module=FakeRelay(),
            socket_path=Path("/tmp/fake-codex.sock"),
            timeout_seconds=1.0,
            server_alias="test",
            notification_projector=notification_projector,
            server_request_projector=server_request_projector,
            event_capacity=100,
            approval_stale_after_seconds=0.05,
            approval_retention_seconds=60.0,
            reconnect_min_seconds=0.01,
            reconnect_max_seconds=0.02,
            transport_factory=factory,
        )
        self.channel.start()
        self.channel.ensure_ready(1.0)

    def tearDown(self) -> None:
        self.channel.close()

    def test_channel_connects_and_exposes_bounded_transport_status(self) -> None:
        snapshot = self.channel.snapshot()
        self.assertEqual(snapshot["state"], "healthy")
        self.assertTrue(snapshot["connected"])
        self.assertEqual(snapshot["generation"], 1)
        self.assertEqual(snapshot["serverIdentity"]["userAgent"], "codex-app-server-test")
        self.assertNotIn("socketPath", snapshot)
        self.assertIn(None, self.state.socket_timeouts)

    def test_multiplexes_out_of_order_responses_without_losing_notifications(self) -> None:
        results: dict[str, Any] = {}
        failures: list[BaseException] = []

        def run(label: str) -> None:
            try:
                results[label] = self.channel.request(label, {"label": label})
            except BaseException as exc:
                failures.append(exc)

        first = threading.Thread(target=run, args=("first",))
        second = threading.Thread(target=run, args=("second",))
        first.start()
        second.start()
        sent_first = self.state.wait_for_sent(lambda value: value.get("method") == "first")
        sent_second = self.state.wait_for_sent(lambda value: value.get("method") == "second")
        self.state.incoming.put(
            {
                "method": "thread/status/changed",
                "params": {
                    "safeSessionRef": "cdx_ses_" + "a" * 32,
                    "status": {"type": "active"},
                },
            }
        )
        self.state.incoming.put(
            {"id": sent_second["id"], "result": {"order": 2}}
        )
        self.state.incoming.put(
            {"id": sent_first["id"], "result": {"order": 1}}
        )
        first.join(timeout=2)
        second.join(timeout=2)
        self.assertFalse(failures)
        self.assertEqual(results, {"first": {"order": 1}, "second": {"order": 2}})
        event_page = self.channel.events(after_sequence=0, limit=100)
        methods = [
            event.get("method")
            for event in event_page["events"]
            if event.get("kind") == "native_notification"
        ]
        self.assertIn("thread/status/changed", methods)

    def test_rpc_error_is_preserved_with_native_method_context(self) -> None:
        result: list[BaseException] = []

        def run() -> None:
            try:
                self.channel.request("thread/read", {"threadId": "private"})
            except BaseException as exc:
                result.append(exc)

        thread = threading.Thread(target=run)
        thread.start()
        sent = self.state.wait_for_sent(
            lambda value: value.get("method") == "thread/read"
        )
        self.state.incoming.put(
            {
                "id": sent["id"],
                "error": {"code": -32004, "message": "not found"},
            }
        )
        thread.join(timeout=2)
        self.assertEqual(len(result), 1)
        self.assertIsInstance(result[0], FakeRpcError)
        self.assertEqual(result[0].method, "thread/read")

    def test_pending_approval_uses_opaque_ref_and_never_projects_native_ids(self) -> None:
        native_thread = "native-thread-secret"
        native_turn = "native-turn-secret"
        self.state.incoming.put(
            {
                "id": 77,
                "method": "item/commandExecution/requestApproval",
                "params": {
                    "threadId": native_thread,
                    "turnId": native_turn,
                    "itemId": "native-item-secret",
                    "command": "printf fixture-command",
                    "safeSessionRef": "cdx_ses_" + "b" * 32,
                    "safeTurnRef": "cdx_turn_" + "c" * 32,
                    "safeItemRef": "cdx_item_" + "d" * 32,
                },
            }
        )
        deadline = time.monotonic() + 2
        approvals: list[dict[str, Any]] = []
        while time.monotonic() < deadline:
            approvals = self.channel.approvals()
            if approvals:
                break
            time.sleep(0.01)
        self.assertEqual(len(approvals), 1)
        approval = approvals[0]
        self.assertRegex(approval["approvalRef"], r"^cdx_apr_[a-f0-9]{32}$")
        serialized = json.dumps(approval, sort_keys=True)
        self.assertNotIn(native_thread, serialized)
        self.assertNotIn(native_turn, serialized)
        self.assertNotIn("printf fixture-command", serialized)
        raw = self.channel.approval_raw(approval["approvalRef"])
        self.assertEqual(raw["rawParams"]["threadId"], native_thread)

    def test_approval_response_is_sent_on_same_generation_and_confirmed(self) -> None:
        def on_send(value: dict[str, Any]) -> None:
            if value.get("id") == 88 and "result" in value:
                self.state.incoming.put(
                    {
                        "method": "serverRequest/resolved",
                        "params": {
                            "requestId": 88,
                            "threadId": "native-thread",
                        },
                    }
                )

        self.state.on_send = on_send
        self.state.incoming.put(
            {
                "id": 88,
                "method": "item/fileChange/requestApproval",
                "params": {
                    "threadId": "native-thread",
                    "turnId": "native-turn",
                    "itemId": "native-item",
                    "safeSessionRef": "cdx_ses_" + "e" * 32,
                    "safeTurnRef": "cdx_turn_" + "f" * 32,
                },
            }
        )
        deadline = time.monotonic() + 2
        approval: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            values = self.channel.approvals()
            if values:
                approval = values[0]
                break
            time.sleep(0.01)
        assert approval is not None
        receipt = self.channel.respond(
            approval["approvalRef"],
            result={"decision": "accept"},
            confirm_timeout_seconds=1.0,
        )
        self.assertEqual(receipt["status"], "resolved")
        self.assertTrue(receipt["responseConfirmed"])
        sent = self.state.wait_for_sent(lambda value: value.get("id") == 88)
        self.assertEqual(sent["result"], {"decision": "accept"})
        replay = self.channel.respond(
            approval["approvalRef"],
            result={"decision": "accept"},
            confirm_timeout_seconds=0,
        )
        self.assertEqual(replay["status"], "resolved")
        with self.assertRaises(channel_module.ApprovalResponseConflict):
            self.channel.respond(
                approval["approvalRef"],
                result={"decision": "decline"},
                confirm_timeout_seconds=0,
            )

    def test_elapsed_time_marks_approval_stale_but_keeps_it_answerable(self) -> None:
        def on_send(value: dict[str, Any]) -> None:
            if value.get("id") == 89 and "result" in value:
                self.state.incoming.put(
                    {
                        "method": "serverRequest/resolved",
                        "params": {"requestId": 89, "threadId": "native-thread"},
                    }
                )

        self.state.on_send = on_send
        self.state.incoming.put(
            {
                "id": 89,
                "method": "item/fileChange/requestApproval",
                "params": {
                    "threadId": "native-thread",
                    "turnId": "native-turn",
                    "itemId": "native-item",
                    "safeSessionRef": "cdx_ses_" + "5" * 32,
                    "safeTurnRef": "cdx_turn_" + "6" * 32,
                },
            }
        )
        deadline = time.monotonic() + 2
        approval_ref: str | None = None
        while time.monotonic() < deadline:
            values = self.channel.approvals()
            if values:
                approval_ref = values[0]["approvalRef"]
                break
            time.sleep(0.01)
        assert approval_ref is not None
        time.sleep(0.08)
        stale = self.channel.approval(approval_ref)
        assert stale is not None
        self.assertEqual(stale["status"], "pending")
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["freshness"], "stale")
        self.assertTrue(stale["answerable"])
        self.assertFalse(stale["timeAloneExpiresApproval"])
        snapshot = self.channel.snapshot()
        self.assertEqual(snapshot["staleApprovalCount"], 1)
        self.assertFalse(snapshot["timeAloneExpiresApproval"])

        receipt = self.channel.respond(
            approval_ref,
            result={"decision": "accept"},
            confirm_timeout_seconds=1.0,
        )
        self.assertEqual(receipt["status"], "resolved")
        self.assertTrue(receipt["responseConfirmed"])

    def test_unsupported_client_capability_is_rejected_fail_closed(self) -> None:
        self.state.incoming.put(
            {
                "id": "dynamic-call-1",
                "method": "item/tool/call",
                "params": {
                    "threadId": "private-thread",
                    "turnId": "private-turn",
                    "tool": "fixture-dynamic-tool",
                    "arguments": {"example": "value"},
                },
            }
        )
        sent = self.state.wait_for_sent(
            lambda value: value.get("id") == "dynamic-call-1"
        )
        self.assertEqual(sent["error"]["code"], -32601)
        self.assertEqual(self.channel.approvals(), [])
        snapshot = self.channel.snapshot()
        self.assertEqual(snapshot["unsupportedServerRequests"], 1)

    def test_reasoning_notifications_are_never_buffered(self) -> None:
        self.state.incoming.put(
            {
                "method": "item/reasoning/textDelta",
                "params": {
                    "safeSessionRef": "cdx_ses_" + "1" * 32,
                    "delta": "private chain of thought",
                },
            }
        )
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            if self.channel.snapshot()["notificationsObserved"] >= 1:
                break
            time.sleep(0.01)
        serialized = json.dumps(self.channel.events(limit=100), sort_keys=True)
        self.assertNotIn("private chain of thought", serialized)
        self.assertNotIn("item/reasoning/textDelta", serialized)

    def test_disconnect_marks_inflight_request_unknown_and_expires_approval(self) -> None:
        self.state.incoming.put(
            {
                "id": 99,
                "method": "item/commandExecution/requestApproval",
                "params": {
                    "threadId": "native-thread",
                    "turnId": "native-turn",
                    "itemId": "native-item",
                    "safeSessionRef": "cdx_ses_" + "2" * 32,
                    "safeTurnRef": "cdx_turn_" + "3" * 32,
                },
            }
        )
        deadline = time.monotonic() + 2
        approval_ref: str | None = None
        while time.monotonic() < deadline:
            approvals = self.channel.approvals()
            if approvals:
                approval_ref = approvals[0]["approvalRef"]
                break
            time.sleep(0.01)
        assert approval_ref is not None
        failures: list[BaseException] = []

        def run() -> None:
            try:
                self.channel.request("turn/start", {"threadId": "private"})
            except BaseException as exc:
                failures.append(exc)

        thread = threading.Thread(target=run)
        thread.start()
        self.state.wait_for_sent(lambda value: value.get("method") == "turn/start")
        self.state.incoming.put(_Disconnect(OSError("forced disconnect")))
        thread.join(timeout=2)
        self.assertEqual(len(failures), 1)
        self.assertIsInstance(failures[0], channel_module.ChannelOutcomeUnknown)
        deadline = time.monotonic() + 2
        terminal: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            terminal = self.channel.approval(approval_ref)
            if terminal and terminal["status"] == "expired":
                break
            time.sleep(0.01)
        assert terminal is not None
        self.assertEqual(terminal["status"], "expired")

    def test_event_sequence_reports_gap_after_capacity_rollover(self) -> None:
        for index in range(120):
            self.state.incoming.put(
                {
                    "method": "thread/status/changed",
                    "params": {
                        "safeSessionRef": "cdx_ses_" + "4" * 32,
                        "index": index,
                    },
                }
            )
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if self.channel.snapshot()["notificationsObserved"] >= 120:
                break
            time.sleep(0.01)
        page = self.channel.events(after_sequence=1, limit=100)
        self.assertTrue(page["gapDetected"])
        self.assertGreater(page["oldestAvailableSequence"], 1)
        self.assertLessEqual(len(page["events"]), 100)


if __name__ == "__main__":
    unittest.main()

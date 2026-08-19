#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sqlite3
import socket
import tempfile
import threading
import unittest


SCRIPT = Path(__file__).with_name("zes-conversation-transport-bridge.py")
SPEC = importlib.util.spec_from_file_location("zes_conversation_bridge", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
bridge_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge_module)


class FakeRpc:
    def __init__(self, thread_id: str = "thread-1", lifecycle: str = "idle") -> None:
        self.thread_id = thread_id
        self.lifecycle = lifecycle

    def __enter__(self) -> "FakeRpc":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def initialize(self) -> dict[str, object]:
        return {"userAgent": "codex-app-server-test"}

    def request(self, method: str, params: dict[str, object]) -> dict[str, object]:
        if method == "thread/read":
            assert params["threadId"] == self.thread_id
            return {
                "thread": {
                    "id": self.thread_id,
                    "status": {"type": self.lifecycle},
                    "canAcceptDirectInput": True,
                }
            }
        raise AssertionError(f"unexpected RPC method: {method}")


def make_bridge(target: dict[str, object]) -> object:
    instance = bridge_module.Bridge.__new__(bridge_module.Bridge)
    instance.config = {
        "targets": {target["targetAlias"]: target},
        "appServerSocket": Path("/tmp/not-used.sock"),
        "stateDir": Path(tempfile.mkdtemp(prefix="zes-bridge-state-")),
        "timeoutSeconds": 5,
        "effectsEnabled": False,
    }
    instance.relay = object()
    instance._lock_path = instance.config["stateDir"] / "bridge.lock"
    instance.rpc = lambda: FakeRpc(str(target.get("native", {}).get("threadId", "thread-1")))
    return instance


class ConversationTransportBridgeTests(unittest.TestCase):
    def test_codex_status_is_stable_and_native_first(self) -> None:
        target = {
            "targetAlias": "codex-canary",
            "targetKind": "codex_thread",
            "bindingGeneration": 1,
            "native": {"threadId": "thread-canary"},
        }
        bridge = make_bridge(target)
        first = bridge.status("codex-canary")
        second = bridge.status("codex-canary")

        self.assertEqual(first["evidenceDigestSha256"], second["evidenceDigestSha256"])
        self.assertEqual(first["targetKind"], "codex_thread")
        self.assertEqual(first["candidates"][0]["kind"], "native_rpc")
        self.assertEqual(first["candidates"][0]["availability"], "available")
        self.assertEqual(first["candidates"][0]["binding"], "exact")
        self.assertNotIn("thread-canary", json.dumps(first))

    def test_chatgpt_work_native_route_fails_closed_with_typed_limit(self) -> None:
        target = {
            "targetAlias": "work-canary",
            "targetKind": "chatgpt_work",
            "bindingGeneration": 1,
        }
        bridge = make_bridge(target)
        status = bridge.status("work-canary")

        self.assertIn(
            "UPSTREAM_CHAT_WORK_NATIVE_CONTROL_PROTOCOL_UNATTESTED",
            status["limitationCodes"],
        )
        native = status["candidates"][0]
        self.assertEqual(native["kind"], "native_rpc")
        self.assertEqual(native["availability"], "unavailable")
        self.assertEqual(native["surfaceTrust"], "official")

    def test_delivery_ledger_never_has_a_prompt_column(self) -> None:
        with tempfile.TemporaryDirectory(prefix="zes-bridge-ledger-") as root:
            connection = bridge_module.open_ledger(Path(root))
            try:
                columns = {
                    row[1]
                    for row in connection.execute("pragma table_info(deliveries)").fetchall()
                }
            finally:
                connection.close()
        self.assertNotIn("prompt", columns)
        self.assertNotIn("message", columns)
        self.assertIn("prompt_digest_sha256", columns)
        self.assertIn("message_id", columns)

    def test_route_digest_is_order_stable_and_binds_transport(self) -> None:
        transport = {
            "transportId": "codex-app-server:canary",
            "kind": "native_rpc",
        }
        digest = bridge_module.route_digest(
            target_alias="canary",
            target_kind="codex_thread",
            target_ref_digest="a" * 64,
            binding_ref="ctb_1",
            binding_generation=2,
            transport=transport,
            evidence_digest="b" * 64,
        )
        self.assertRegex(digest, r"^[a-f0-9]{64}$")
        self.assertEqual(
            digest,
            "edda5d766ba3a62f6e712b450a5948b2b1e7c0d829173caf8fe685a144276326",
        )
        changed = bridge_module.route_digest(
            target_alias="canary",
            target_kind="codex_thread",
            target_ref_digest="a" * 64,
            binding_ref="ctb_1",
            binding_generation=2,
            transport={**transport, "transportId": "playwright:canary"},
            evidence_digest="b" * 64,
        )
        self.assertNotEqual(digest, changed)

    def test_unknown_alias_is_rejected_without_accepting_a_thread_id(self) -> None:
        target = {
            "targetAlias": "codex-canary",
            "targetKind": "codex_thread",
            "bindingGeneration": 1,
            "native": {"threadId": "thread-canary"},
        }
        bridge = make_bridge(target)
        with self.assertRaisesRegex(bridge_module.BridgeError, "not configured"):
            bridge.target("thread-canary")

    def test_bridge_effect_lock_rejects_an_active_host_turn(self) -> None:
        target = {
            "targetAlias": "codex-active",
            "targetKind": "codex_thread",
            "bindingGeneration": 1,
            "native": {"threadId": "thread-active"},
        }
        bridge = make_bridge(target)
        bridge.config["effectsEnabled"] = True
        bridge.rpc = lambda: FakeRpc("thread-active", "active")
        status = bridge.status("codex-active")
        selected = status["candidates"][0]
        route = bridge_module.route_digest(
            target_alias=status["targetAlias"],
            target_kind=status["targetKind"],
            target_ref_digest=status["targetRefDigestSha256"],
            binding_ref=status["bindingRef"],
            binding_generation=status["bindingGeneration"],
            transport=selected,
            evidence_digest=status["evidenceDigestSha256"],
        )
        prompt = "continue exact pending work"
        receipt = bridge.deliver({
            "targetAlias": status["targetAlias"],
            "targetRefDigestSha256": status["targetRefDigestSha256"],
            "bindingRef": status["bindingRef"],
            "bindingGeneration": status["bindingGeneration"],
            "permitRef": "permit:active-host-turn",
            "transportId": selected["transportId"],
            "transportKind": selected["kind"],
            "routeDigestSha256": route,
            "messageId": "message:active-host-turn",
            "prompt": prompt,
            "promptDigestSha256": bridge_module.sha256(prompt),
        })
        self.assertEqual(receipt["state"], "no_effect")
        self.assertEqual(receipt["failureCode"], "HOST_TURN_NOT_WAKE_ELIGIBLE")
        self.assertEqual(
            bridge_module.wake_eligible_session_lifecycle("responsive_idle"),
            True,
        )
        self.assertEqual(
            bridge_module.wake_eligible_session_lifecycle("not_observed"),
            False,
        )

    def test_unix_socket_protocol_is_line_bounded_and_peer_checked(self) -> None:
        with tempfile.TemporaryDirectory(prefix="zes-bridge-socket-") as root:
            root_path = Path(root)
            config = {
                "targets": {
                    "codex-canary": {
                        "targetAlias": "codex-canary",
                        "targetKind": "codex_thread",
                        "bindingGeneration": 1,
                        "native": {"threadId": "thread-canary"},
                    }
                },
                "relayModulePath": Path(
                    "/root/.codex/skills/codex-thread-relay/scripts/codex_thread_relay.py"
                ),
                "appServerSocket": Path("/tmp/not-used.sock"),
                "stateDir": root_path / "state",
                "socketPath": root_path / "bridge.sock",
                "socketMode": "0600",
                "allowedPeerUids": {bridge_module.os.getuid()},
                "effectsEnabled": False,
            }
            server = bridge_module.BridgeUnixServer(config)
            server.bridge = make_bridge(config["targets"]["codex-canary"])
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(2)
                    client.connect(str(config["socketPath"]))
                    client.sendall(
                        b'{"schemaVersion":1,"command":"status","targetAlias":"codex-canary"}\n'
                    )
                    response = b""
                    while not response.endswith(b"\n"):
                        response += client.recv(65536)
                payload = json.loads(response.decode("utf-8"))
                self.assertTrue(payload["ok"])
                self.assertEqual(payload["command"], "status")
                self.assertEqual(payload["status"]["targetAlias"], "codex-canary")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

            denied_config = {
                **config,
                "socketPath": root_path / "denied.sock",
                "allowedPeerUids": set(),
            }
            denied = bridge_module.BridgeUnixServer(denied_config)
            denied.bridge = make_bridge(config["targets"]["codex-canary"])
            denied_thread = threading.Thread(target=denied.serve_forever, daemon=True)
            denied_thread.start()
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(2)
                    client.connect(str(denied_config["socketPath"]))
                    client.sendall(
                        b'{"schemaVersion":1,"command":"status","targetAlias":"codex-canary"}\n'
                    )
                    try:
                        rejected = client.recv(1024)
                    except ConnectionResetError:
                        rejected = b""
                    self.assertEqual(rejected, b"")
            finally:
                denied.shutdown()
                denied.server_close()
                denied_thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()

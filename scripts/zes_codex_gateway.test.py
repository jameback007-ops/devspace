#!/usr/bin/env python3

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("zes_codex_gateway.py")
SPEC = importlib.util.spec_from_file_location("zes_codex_gateway_tested", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
gateway_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gateway_module)


class FakeRpcError(RuntimeError):
    def __init__(self, method: str, error: object) -> None:
        super().__init__(f"{method} failed: {json.dumps(error, sort_keys=True)}")
        self.method = method
        self.error = error


class FakeRelay:
    RpcError = FakeRpcError


class FakeRpc:
    def __init__(self, state: dict[str, object]) -> None:
        self.state = state

    def __enter__(self) -> "FakeRpc":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def initialize(self) -> dict[str, object]:
        return {
            "userAgent": self.state.get("userAgent", "codex-app-server-test"),
            "platformFamily": "unix",
            "platformOs": "linux",
        }

    def request(self, method: str, params: dict[str, object]) -> dict[str, object]:
        fail = self.state.get("fail")
        if fail == method:
            raise RuntimeError(f"transport dropped during {method}")
        reject = self.state.get("reject")
        if reject == method:
            error = self.state.get("reject_error")
            raise FakeRpcError(
                method,
                error
                if isinstance(error, dict)
                else {"code": -32602, "message": "rejected"},
            )
        threads = self.state["threads"]
        assert isinstance(threads, dict)
        loaded = self.state["loaded"]
        assert isinstance(loaded, set)
        if method == "thread/list":
            data = list(threads.values())
            data.sort(key=lambda item: item["updatedAt"], reverse=True)
            limit = int(params.get("limit", 20))
            return {"data": data[:limit], "nextCursor": None}
        if method == "thread/loaded/list":
            return {"data": sorted(loaded), "nextCursor": None}
        if method == "thread/read":
            thread_id = str(params["threadId"])
            if thread_id not in threads:
                raise FakeRpcError(
                    method,
                    {"code": -32004, "message": "thread not found"},
                )
            thread = dict(threads[thread_id])
            if params.get("includeTurns") is True:
                thread["turns"] = list(self.state["turns"].get(thread_id, []))
            return {"thread": thread}
        if method == "thread/goal/get":
            return {"goal": self.state["goals"].get(str(params["threadId"]))}
        if method == "thread/goal/set":
            thread_id = str(params["threadId"])
            prior = self.state["goals"].get(thread_id) or {"threadId": thread_id}
            goal = dict(prior)
            for key in ("objective", "status", "tokenBudget"):
                if key in params:
                    goal[key] = params[key]
            if self.state.get("goal_readback_mismatch"):
                goal["status"] = "blocked"
            self.state["goals"][thread_id] = goal
            return {"goal": goal}
        if method == "thread/goal/clear":
            self.state["goals"][str(params["threadId"])] = None
            return {"cleared": True}
        if method == "account/usage/read":
            if params:
                if self.state.get("userAgent") != "codex_core_rs/0.149.0":
                    raise FakeRpcError(method, {"code": -32600, "message": "expected unit"})
                thread_id = str(params["threadId"])
                return {
                    "summary": {"lifetimeTokens": 1234},
                    "dailyUsageBuckets": [],
                    "threadUsage": {
                        "threadId": thread_id,
                        "estimatedUsageCreditsMicros": 77,
                        "estimatedUsageUsdMicros": 55,
                        "groups": [
                            {
                                "model": "gpt-test",
                                "reasoningEffort": "high",
                                "speed": "standard",
                                "inputTokens": 100,
                                "cachedInputTokens": 40,
                                "netNewInputTokens": 60,
                                "outputTokens": 20,
                                "totalTokens": 120,
                                "estimatedUsageCreditsMicros": 77,
                            }
                        ],
                    },
                }
            return {
                "summary": {"lifetimeTokens": 1234},
                "dailyUsageBuckets": [{"startDate": "2026-08-21", "tokens": 1234}],
            }
        if method == "account/rateLimits/read":
            return {
                "rateLimits": {
                    "limitId": "codex",
                    "primary": {"usedPercent": 12},
                },
                "rateLimitsByLimitId": {},
            }
        if method == "model/list":
            return {
                "data": [
                    {
                        "id": "gpt-test",
                        "model": "gpt-test",
                        "displayName": "GPT Test",
                        "hidden": False,
                        "isDefault": True,
                    }
                ],
                "nextCursor": None,
            }
        if method in {"thread/start", "thread/resume", "thread/fork"}:
            if method == "thread/start":
                thread_id = "thread-created"
                source = next(iter(threads.values()))
                thread = dict(source)
                thread.update({"id": thread_id, "name": "created", "status": {"type": "idle"}})
                threads[thread_id] = thread
                self.state["turns"][thread_id] = []
            elif method == "thread/fork":
                source_id = str(params["threadId"])
                thread_id = "thread-forked"
                thread = dict(threads[source_id])
                thread.update({"id": thread_id, "parentThreadId": source_id})
                threads[thread_id] = thread
                self.state["turns"][thread_id] = []
            else:
                thread_id = str(params["threadId"])
                thread = threads[thread_id]
                thread["status"] = {"type": "idle"}
            loaded.add(thread_id)
            return {
                "thread": dict(threads[thread_id]),
                "approvalPolicy": "on-request",
                "approvalsReviewer": "user",
                "cwd": threads[thread_id]["cwd"],
                "model": "gpt-test",
                "modelProvider": "openai",
                "sandbox": {"type": "workspaceWrite"},
            }
        if method in {"turn/start", "turn/steer"}:
            thread_id = str(params["threadId"])
            if method == "turn/start" and self.state.get("start_race_once"):
                self.state["start_race_once"] = False
                turn = {
                    "id": "turn-raced",
                    "status": "inProgress",
                    "startedAt": 1,
                    "completedAt": None,
                    "items": [],
                }
                self.state["turns"][thread_id].append(turn)
                raise FakeRpcError(method, {"message": "active turn appeared"})
            active = next(
                (
                    turn
                    for turn in self.state["turns"].get(thread_id, [])
                    if turn.get("status") == "inProgress"
                ),
                None,
            )
            if method == "turn/steer":
                if active is None:
                    raise FakeRpcError(method, {"message": "no active turn"})
                turn = active
            else:
                turn = {
                    "id": "turn-started",
                    "status": "inProgress",
                    "startedAt": 1,
                    "completedAt": None,
                    "items": [],
                }
                self.state["turns"][thread_id].append(turn)
            turn["items"].append(
                {
                    "id": f"item-{len(turn['items']) + 1}",
                    "type": "userMessage",
                    "clientId": params.get("clientUserMessageId"),
                    "content": params.get("input"),
                }
            )
            if method == "turn/steer":
                return {"turnId": turn["id"]}
            return {"turn": turn}
        if method == "turn/interrupt":
            thread_id = str(params["threadId"])
            for turn in self.state["turns"][thread_id]:
                if turn["id"] == params["turnId"]:
                    turn["status"] = "interrupted"
            return {}
        if method == "thread/name/set":
            threads[str(params["threadId"])]["name"] = (
                "mismatched-name"
                if self.state.get("name_readback_mismatch")
                else params["name"]
            )
            return {}
        if method == "thread/rollback":
            return {"thread": dict(threads[str(params["threadId"])])}
        if method == "thread/unarchive":
            return {"thread": dict(threads[str(params["threadId"])])}
        if method == "thread/unsubscribe":
            return {"status": "notSubscribed"}
        if method in {"thread/compact/start", "thread/archive"}:
            return {}
        if method == "thread/delete":
            threads.pop(str(params["threadId"]), None)
            return {}
        raise AssertionError(f"unexpected RPC method {method}")


class TestGateway(gateway_module.CodexGateway):
    def __init__(self, config: dict[str, object], state: dict[str, object]) -> None:
        self.fake_state = state
        super().__init__(config, FakeRelay())

    def _rpc(self, _server: dict[str, object]) -> FakeRpc:
        return FakeRpc(self.fake_state)


class FakeApprovalUnavailable(RuntimeError):
    pass


class FakeApprovalResponseConflict(FakeApprovalUnavailable):
    pass


class FakeChannelModule:
    ApprovalUnavailable = FakeApprovalUnavailable
    ApprovalResponseConflict = FakeApprovalResponseConflict


class FakePersistentChannel:
    def __init__(
        self,
        approval: dict[str, object] | None = None,
        *,
        user_agent: str = "codex_core_rs/0.147.0",
    ) -> None:
        self.projected = approval
        self.user_agent = user_agent
        self.raw = None if approval is None else {
            "approvalRef": approval["approvalRef"],
            "method": approval["method"],
            "generation": 1,
            "status": approval.get("status", "pending"),
            "rawParams": approval["rawParams"],
            "projection": approval["projection"],
        }
        self.responses: list[dict[str, object]] = []

    def start(self) -> None:
        return None

    def ensure_ready(self, _timeout: float | None = None) -> None:
        return None

    def initialize(self) -> dict[str, object]:
        return {
            "userAgent": self.user_agent,
            "platformFamily": "unix",
            "platformOs": "linux",
        }

    def snapshot(self) -> dict[str, object]:
        return {
            "state": "healthy",
            "connected": True,
            "generation": 1,
            "pendingApprovalCount": 1 if self.projected else 0,
            "serverIdentity": self.initialize(),
        }

    def events(self, **_kwargs: object) -> dict[str, object]:
        return {
            "events": [{"sequence": 1, "kind": "native_notification"}],
            "oldestAvailableSequence": 1,
            "latestSequence": 1,
            "nextAfterSequence": 1,
            "gapDetected": False,
            "truncated": False,
        }

    def approvals(self, **_kwargs: object) -> list[dict[str, object]]:
        return [dict(self.projected)] if self.projected else []

    def approval(self, approval_ref: str) -> dict[str, object] | None:
        if self.projected and self.projected["approvalRef"] == approval_ref:
            return dict(self.projected)
        return None

    def approval_raw(self, approval_ref: str) -> dict[str, object] | None:
        if self.raw and self.raw["approvalRef"] == approval_ref:
            return dict(self.raw)
        return None

    def respond(
        self,
        approval_ref: str,
        *,
        result: dict[str, object] | None = None,
        error: dict[str, object] | None = None,
        confirm_timeout_seconds: float = 0,
    ) -> dict[str, object]:
        self.responses.append(
            {
                "approvalRef": approval_ref,
                "result": result,
                "error": error,
                "confirmTimeoutSeconds": confirm_timeout_seconds,
            }
        )
        assert self.projected is not None
        self.projected = {
            **self.projected,
            "status": "resolved",
            "responseConfirmed": True,
            "respondedAt": "2026-08-21T00:00:01Z",
            "resolvedAt": "2026-08-21T00:00:02Z",
        }
        return dict(self.projected)

    def close(self) -> None:
        return None


class PersistentTestGateway(TestGateway):
    def __init__(
        self,
        config: dict[str, object],
        state: dict[str, object],
        channel: FakePersistentChannel,
    ) -> None:
        super().__init__(
            {**config, "codexGatewayPersistentChannels": False},
            state,
        )
        self.persistent_channels_enabled = True
        self.channel_module = FakeChannelModule()
        self.fake_channel = channel

    def _channel(self, _server: dict[str, object]) -> FakePersistentChannel:
        return self.fake_channel


class CodexGatewayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="zes-codex-gateway-")
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.rollouts = self.root / "sessions"
        self.state_dir = self.root / "state"
        self.workspace.mkdir()
        self.rollouts.mkdir()
        self.thread_id = "thread-private-native-id"
        self.rollout = self.rollouts / f"rollout-{self.thread_id}.jsonl"
        records = [
            {"timestamp": "2026-08-21T00:00:00Z", "type": "session_meta", "payload": {}},
            {
                "timestamp": "2026-08-21T00:00:01Z",
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "turn-private"},
            },
            {
                "timestamp": "2026-08-21T00:00:02Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "token=sk-secret123456789"}],
                    "internal_chat_message_metadata_passthrough": {"turn_id": "turn-private"},
                },
            },
            {
                "timestamp": "2026-08-21T00:00:03Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "last_token_usage": {"total_tokens": 10, "input_tokens": 8},
                        "total_token_usage": {"total_tokens": 10, "input_tokens": 8},
                    },
                },
            },
            {"timestamp": "2026-08-21T00:00:04Z", "type": "compacted", "payload": {}},
            {
                "timestamp": "2026-08-21T00:00:05Z",
                "type": "event_msg",
                "payload": {"type": "task_complete", "turn_id": "turn-private"},
            },
        ]
        self.rollout.write_text("\n".join(json.dumps(item) for item in records) + "\n")
        thread = {
            "id": self.thread_id,
            "sessionId": self.thread_id,
            "name": "test thread",
            "preview": "private preview",
            "status": {"type": "idle"},
            "canAcceptDirectInput": True,
            "createdAt": 1,
            "updatedAt": 2,
            "recencyAt": 2,
            "path": str(self.rollout),
            "cwd": str(self.workspace),
            "gitInfo": {"sha": "a" * 40, "branch": "main", "originUrl": "secret-origin"},
            "turns": [],
        }
        self.fake_state: dict[str, object] = {
            "threads": {self.thread_id: thread},
            "loaded": {self.thread_id},
            "turns": {self.thread_id: []},
            "goals": {
                self.thread_id: {
                    "threadId": self.thread_id,
                    "objective": "private objective",
                    "status": "active",
                    "tokensUsed": 10,
                }
            },
        }
        self.config: dict[str, object] = {
            "stateDir": self.state_dir,
            "appServerSocket": self.root / "fake.sock",
            "codexGatewayEnabled": True,
            "codexGatewayEffectsEnabled": True,
            "codexGatewayPersistentChannels": False,
            "codexRolloutRoots": [self.rollouts],
            "codexWorkspaceBindings": {"test": self.workspace},
        }
        self.gateway = TestGateway(self.config, self.fake_state)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def discover(self) -> dict[str, object]:
        page = self.gateway.handle({"command": "codex_session_list", "limit": 10})
        return page["sessions"][0]

    def test_discovery_and_read_never_expose_native_thread_or_paths(self) -> None:
        session = self.discover()
        observed = self.gateway.handle(
            {"command": "codex_session_read", "sessionRef": session["sessionRef"]}
        )
        serialized = json.dumps(observed, sort_keys=True)
        self.assertNotIn(self.thread_id, serialized)
        self.assertNotIn(str(self.workspace), serialized)
        self.assertNotIn("private objective", serialized)
        self.assertEqual(observed["session"]["workspace"]["workspaceAlias"], "test")
        self.assertRegex(observed["session"]["goal"]["objectiveDigestSha256"], r"^[a-f0-9]{64}$")

    def test_activity_redacts_secrets_and_excludes_private_reasoning(self) -> None:
        session = self.discover()
        observed = self.gateway.handle(
            {
                "command": "codex_session_activity",
                "sessionRef": session["sessionRef"],
                "view": "audit",
                "limit": 20,
            }
        )
        serialized = json.dumps(observed, sort_keys=True)
        self.assertNotIn("sk-secret123456789", serialized)
        self.assertIn("[REDACTED_TOKEN]", serialized)
        self.assertTrue(observed["policy"]["privateReasoningExcluded"])

    def test_activity_cursor_expiry_is_checked_without_global_purge(self) -> None:
        session = self.discover()
        first = self.gateway.handle(
            {
                "command": "codex_session_activity",
                "sessionRef": session["sessionRef"],
                "view": "combined",
                "limit": 1,
            }
        )
        cursor_ref = first["nextCursorRef"]
        self.assertIsNotNone(cursor_ref)
        ledger = sqlite3.connect(self.state_dir / "codex-gateway.sqlite3")
        try:
            ledger.execute(
                "update cursors set created_at=? where cursor_ref=?",
                ("2000-01-01T00:00:00+00:00", cursor_ref),
            )
            ledger.commit()
        finally:
            ledger.close()
        with self.assertRaisesRegex(
            gateway_module.GatewayError,
            "Unknown or expired Codex cursor ref",
        ):
            self.gateway.handle(
                {
                    "command": "codex_session_activity",
                    "sessionRef": session["sessionRef"],
                    "view": "combined",
                    "limit": 1,
                    "cursorRef": cursor_ref,
                }
            )

    def test_metrics_are_incremental_and_count_compaction(self) -> None:
        session = self.discover()
        first = self.gateway.handle(
            {"command": "codex_session_metrics", "sessionRef": session["sessionRef"]}
        )
        second = self.gateway.handle(
            {"command": "codex_session_metrics", "sessionRef": session["sessionRef"]}
        )
        self.assertEqual(first["metrics"]["lifecycle"]["contextCompactions"], 1)
        self.assertEqual(first["metrics"]["tokens"]["latestCumulative"]["total_tokens"], 10)
        self.assertFalse(first["incrementalIndexReused"])
        self.assertTrue(second["incrementalIndexReused"])
        ledger = sqlite3.connect(self.state_dir / "codex-gateway.sqlite3")
        try:
            aggregate_json = ledger.execute(
                "select aggregate_json from metrics where session_ref=?",
                (session["sessionRef"],),
            ).fetchone()[0]
        finally:
            ledger.close()
        self.assertNotIn("turn-private", aggregate_json)
        self.assertIn("cdx_turn_", aggregate_json)

    def test_metrics_scan_is_bounded_and_resumes_from_persisted_offset(self) -> None:
        session = self.discover()
        prior_limit = gateway_module.MAX_METRICS_RECORDS_PER_CALL
        gateway_module.MAX_METRICS_RECORDS_PER_CALL = 2
        try:
            observations = []
            for _ in range(10):
                observation = self.gateway.handle(
                    {
                        "command": "codex_session_metrics",
                        "sessionRef": session["sessionRef"],
                    }
                )
                observations.append(observation)
                if observation["completeAtObservation"]:
                    break
        finally:
            gateway_module.MAX_METRICS_RECORDS_PER_CALL = prior_limit
        self.assertGreater(len(observations), 1)
        self.assertFalse(observations[0]["completeAtObservation"])
        self.assertTrue(observations[0]["scanLimited"])
        self.assertTrue(observations[-1]["completeAtObservation"])
        self.assertTrue(observations[-1]["incrementalIndexReused"])
        offsets = [item["indexedThroughBytes"] for item in observations]
        self.assertEqual(offsets, sorted(offsets))
        self.assertEqual(len(offsets), len(set(offsets)))

    def test_read_paths_remain_safe_under_parallel_session_inspection(self) -> None:
        session = self.discover()

        def inspect(index: int) -> str:
            if index % 2 == 0:
                page = self.gateway.handle(
                    {"command": "codex_session_list", "limit": 5}
                )
                return page["sessions"][0]["sessionRef"]
            observation = self.gateway.handle(
                {
                    "command": "codex_session_read",
                    "sessionRef": session["sessionRef"],
                    "turnLimit": 5,
                }
            )
            return observation["session"]["sessionRef"]

        with ThreadPoolExecutor(max_workers=8) as pool:
            refs = list(pool.map(inspect, range(32)))
        self.assertEqual(set(refs), {session["sessionRef"]})

    def test_effects_fail_closed_when_disabled(self) -> None:
        disabled = TestGateway({**self.config, "codexGatewayEffectsEnabled": False}, self.fake_state)
        session = disabled.handle({"command": "codex_session_list", "limit": 1})["sessions"][0]
        with self.assertRaisesRegex(gateway_module.GatewayError, "effects are disabled"):
            disabled.handle(
                {
                    "command": "codex_turn_control",
                    "action": "submit",
                    "sessionRef": session["sessionRef"],
                    "message": "test",
                    "idempotencyKey": "disabled-test",
                }
            )

    def test_legacy_session_alias_unique_schema_migrates_transactionally(self) -> None:
        legacy_state = self.root / "legacy-state"
        legacy_state.mkdir()
        database_path = legacy_state / "codex-gateway.sqlite3"
        connection = sqlite3.connect(database_path)
        try:
            connection.execute(
                """
                create table sessions (
                  session_ref text primary key,
                  server_alias text not null,
                  thread_id text not null,
                  created_at text not null,
                  last_seen_at text not null,
                  deleted_at text,
                  unique(server_alias, thread_id)
                )
                """
            )
            connection.execute(
                """
                insert into sessions (
                  session_ref, server_alias, thread_id, created_at,
                  last_seen_at, deleted_at
                ) values (?, ?, ?, ?, ?, null)
                """,
                (
                    "cdx_ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "primary",
                    "legacy-thread",
                    "2026-08-21T00:00:00Z",
                    "2026-08-21T00:00:00Z",
                ),
            )
            connection.commit()
        finally:
            connection.close()

        gateway = TestGateway(
            {**self.config, "stateDir": legacy_state},
            self.fake_state,
        )
        gateway.handle({"command": "codex_gateway_status"})
        migrated = sqlite3.connect(database_path)
        try:
            sql = migrated.execute(
                "select sql from sqlite_master where type='table' and name='sessions'"
            ).fetchone()[0]
            preserved = migrated.execute(
                "select count(*) from sessions where thread_id='legacy-thread'"
            ).fetchone()[0]
        finally:
            migrated.close()
        self.assertNotIn(
            "unique(server_alias,thread_id)",
            "".join(sql.lower().split()),
        )
        self.assertEqual(preserved, 1)

    def test_redaction_masks_absolute_paths_without_destroying_web_urls(self) -> None:
        text = gateway_module.redact(
            "read /srv/private/project/file.txt and https://example.com/docs/page"
        )
        self.assertNotIn("/srv/private/project/file.txt", text)
        self.assertIn("[REDACTED_PATH]", text)
        self.assertIn("https://example.com/docs/page", text)

    def test_reverse_reader_skips_oversized_records_without_fragments(self) -> None:
        path = self.root / "oversized.jsonl"
        path.write_bytes(b"first\n" + (b"x" * 200) + b"\nlast\n")
        prior_limit = gateway_module.MAX_ROLLOUT_LINE_BYTES
        gateway_module.MAX_ROLLOUT_LINE_BYTES = 32
        try:
            lines = [
                line.decode("utf-8")
                for _offset, line in gateway_module.reverse_lines(
                    path, path.stat().st_size
                )
            ]
        finally:
            gateway_module.MAX_ROLLOUT_LINE_BYTES = prior_limit
        self.assertEqual(lines, ["last", "first"])

    def test_submit_retries_start_or_steer_race_and_replays_idempotently(self) -> None:
        session = self.discover()
        self.fake_state["start_race_once"] = True
        request = {
            "command": "codex_turn_control",
            "action": "submit",
            "sessionRef": session["sessionRef"],
            "message": "coordinate safely",
            "idempotencyKey": "submit-race-test",
        }
        first = self.gateway.handle(request)
        second = self.gateway.handle(request)
        self.assertEqual(first["state"], "succeeded")
        self.assertEqual(first["result"]["route"], "steer")
        self.assertTrue(second["idempotentReplay"])
        self.assertEqual(first["effectRef"], second["effectRef"])
        serialized = json.dumps(second, sort_keys=True)
        self.assertNotIn("coordinate safely", serialized)

    def test_idempotency_key_cannot_be_reused_for_different_message(self) -> None:
        session = self.discover()
        base = {
            "command": "codex_turn_control",
            "action": "submit",
            "sessionRef": session["sessionRef"],
            "idempotencyKey": "same-key",
        }
        self.gateway.handle({**base, "message": "one"})
        with self.assertRaisesRegex(gateway_module.GatewayError, "another Codex effect"):
            self.gateway.handle({**base, "message": "two"})

    def test_transport_failure_becomes_indeterminate_not_replayed(self) -> None:
        session = self.discover()
        self.fake_state["fail"] = "turn/start"
        request = {
            "command": "codex_turn_control",
            "action": "submit",
            "sessionRef": session["sessionRef"],
            "message": "transport failure",
            "idempotencyKey": "indeterminate-test",
        }
        receipt = self.gateway.handle(request)
        self.assertEqual(receipt["state"], "indeterminate")
        replay = self.gateway.handle(request)
        self.assertEqual(replay["state"], "indeterminate")
        self.assertTrue(replay["idempotentReplay"])

    def test_pre_dispatch_transport_failure_is_rejected_without_unknown_effect(self) -> None:
        session = self.discover()
        self.fake_state["fail"] = "thread/read"
        receipt = self.gateway.handle(
            {
                "command": "codex_turn_control",
                "action": "submit",
                "sessionRef": session["sessionRef"],
                "message": "must not reach the effect boundary",
                "idempotencyKey": "pre-dispatch-failure-test",
            }
        )
        self.assertEqual(receipt["state"], "rejected")
        self.assertFalse(receipt["result"]["dispatchAttempted"])
        self.assertFalse(receipt["result"]["effectObserved"])

    def test_rpc_rejection_exposes_only_generic_summary_and_digest(self) -> None:
        session = self.discover()
        self.fake_state["reject"] = "turn/start"
        self.fake_state["reject_error"] = {
            "code": -32602,
            "message": (
                f"thread {self.thread_id} rejected at "
                f"{self.workspace}/private-file.txt"
            ),
        }
        receipt = self.gateway.handle(
            {
                "command": "codex_turn_control",
                "action": "submit",
                "sessionRef": session["sessionRef"],
                "message": "trigger typed rejection",
                "idempotencyKey": "rpc-rejection-redaction-test",
            }
        )
        serialized = json.dumps(receipt, sort_keys=True)
        self.assertEqual(receipt["state"], "rejected")
        self.assertNotIn(self.thread_id, serialized)
        self.assertNotIn(str(self.workspace), serialized)
        self.assertIn("errorDigestSha256", receipt["result"])
        self.assertEqual(receipt["result"]["summaryTruncated"], False)

    def test_session_control_readback_mismatch_is_indeterminate(self) -> None:
        session = self.discover()
        self.fake_state["name_readback_mismatch"] = True
        receipt = self.gateway.handle(
            {
                "command": "codex_session_control",
                "action": "name_set",
                "sessionRef": session["sessionRef"],
                "name": "expected-name",
                "idempotencyKey": "name-readback-mismatch-test",
            }
        )
        self.assertEqual(receipt["state"], "indeterminate")
        self.assertEqual(
            receipt["failureCode"],
            "CODEX_EFFECT_OUTCOME_INDETERMINATE",
        )

    def test_session_start_model_preflight_fails_before_dispatch(self) -> None:
        session = self.discover()
        workspace_ref = session["workspace"]["workspaceRef"]
        self.fake_state["fail"] = "model/list"
        receipt = self.gateway.handle(
            {
                "command": "codex_session_open",
                "mode": "start",
                "workspaceRef": workspace_ref,
                "model": "gpt-test",
                "idempotencyKey": "start-model-preflight-test",
            }
        )
        self.assertEqual(receipt["state"], "rejected")
        self.assertFalse(receipt["result"]["dispatchAttempted"])

    def test_destructive_controls_require_explicit_acknowledgement(self) -> None:
        session = self.discover()
        with self.assertRaisesRegex(gateway_module.GatewayError, "acknowledgeFilesNotReverted"):
            self.gateway.handle(
                {
                    "command": "codex_session_control",
                    "action": "rollback",
                    "sessionRef": session["sessionRef"],
                    "numTurns": 1,
                    "idempotencyKey": "rollback-test",
                }
            )

    def test_delete_reconciliation_requires_exact_thread_missing_evidence(self) -> None:
        session = self.discover()
        self.fake_state["fail"] = "thread/delete"
        receipt = self.gateway.handle(
            {
                "command": "codex_session_control",
                "action": "delete",
                "sessionRef": session["sessionRef"],
                "acknowledgePermanentDelete": True,
                "idempotencyKey": "delete-reconcile-test",
            }
        )
        self.assertEqual(receipt["state"], "indeterminate")

        self.fake_state.pop("fail")
        self.fake_state["reject"] = "thread/read"
        unresolved = self.gateway.handle(
            {
                "command": "codex_effect_status",
                "effectRef": receipt["effectRef"],
                "reconcile": True,
            }
        )
        self.assertEqual(unresolved["state"], "indeterminate")

        self.fake_state.pop("reject")
        self.fake_state["threads"].pop(self.thread_id)
        resolved = self.gateway.handle(
            {
                "command": "codex_effect_status",
                "effectRef": receipt["effectRef"],
                "reconcile": True,
            }
        )
        self.assertEqual(resolved["state"], "succeeded")
        self.assertTrue(resolved["result"]["deleted"])
        with self.assertRaisesRegex(gateway_module.GatewayError, "acknowledgePermanentDelete"):
            self.gateway.handle(
                {
                    "command": "codex_session_control",
                    "action": "delete",
                    "sessionRef": session["sessionRef"],
                    "idempotencyKey": "delete-test",
                }
            )

    def test_account_usage_derives_server_from_session_in_multi_server_mode(self) -> None:
        multi_config = {
            **self.config,
            "codexAppServers": {
                "alpha": {
                    "socketPath": str(self.root / "alpha.sock"),
                    "effectsEnabled": True,
                    "workspaceBindings": {"test": str(self.workspace)},
                },
                "beta": {
                    "socketPath": str(self.root / "beta.sock"),
                    "effectsEnabled": True,
                    "workspaceBindings": {"test": str(self.workspace)},
                },
            },
        }
        gateway = TestGateway(multi_config, self.fake_state)
        status = gateway.handle({"command": "codex_gateway_status"})
        alpha = next(
            server for server in status["servers"] if server["serverAlias"] == "alpha"
        )
        beta = next(
            server for server in status["servers"] if server["serverAlias"] == "beta"
        )
        session = gateway.handle(
            {
                "command": "codex_session_list",
                "serverRef": alpha["serverRef"],
                "limit": 1,
            }
        )["sessions"][0]
        usage = gateway.handle(
            {
                "command": "codex_account_usage",
                "sessionRef": session["sessionRef"],
            }
        )
        self.assertEqual(usage["serverRef"], alpha["serverRef"])
        with self.assertRaisesRegex(
            gateway_module.GatewayError,
            "bound to another Codex App Server",
        ):
            gateway.handle(
                {
                    "command": "codex_account_usage",
                    "serverRef": beta["serverRef"],
                    "sessionRef": session["sessionRef"],
                }
            )

    def test_session_ref_fails_closed_after_server_alias_rebind(self) -> None:
        session = self.discover()
        rebound = TestGateway(
            {
                **self.config,
                "appServerSocket": self.root / "different-app-server.sock",
            },
            self.fake_state,
        )
        with self.assertRaisesRegex(
            gateway_module.GatewayError,
            "App Server identity bound to this session ref changed",
        ):
            rebound.handle(
                {
                    "command": "codex_session_read",
                    "sessionRef": session["sessionRef"],
                }
            )

    def test_effect_ref_fails_closed_after_server_alias_rebind(self) -> None:
        session = self.discover()
        receipt = self.gateway.handle(
            {
                "command": "codex_turn_control",
                "action": "submit",
                "sessionRef": session["sessionRef"],
                "message": "bind this effect to the exact server",
                "idempotencyKey": "server-rebind-effect-test",
            }
        )
        rebound = TestGateway(
            {
                **self.config,
                "appServerSocket": self.root / "different-app-server.sock",
            },
            self.fake_state,
        )
        with self.assertRaisesRegex(
            gateway_module.GatewayError,
            "App Server identity bound to this opaque ref is no longer configured",
        ):
            rebound.handle(
                {
                    "command": "codex_effect_status",
                    "effectRef": receipt["effectRef"],
                }
            )

    def test_raw_native_and_action_irrelevant_fields_are_rejected(self) -> None:
        session = self.discover()
        invalid_requests = [
            {
                "command": "codex_session_read",
                "sessionRef": session["sessionRef"],
                "threadId": self.thread_id,
            },
            {
                "command": "codex_turn_control",
                "action": "submit",
                "sessionRef": session["sessionRef"],
                "turnRef": "cdx_turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "message": "unexpected turn ref",
                "idempotencyKey": "unexpected-submit-field",
            },
            {
                "command": "codex_turn_control",
                "action": "steer",
                "sessionRef": session["sessionRef"],
                "turnRef": "cdx_turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "message": "unexpected model",
                "model": "gpt-test",
                "idempotencyKey": "unexpected-steer-field",
            },
            {
                "command": "codex_session_control",
                "action": "archive",
                "sessionRef": session["sessionRef"],
                "objective": "ignored fields must fail closed",
                "idempotencyKey": "unexpected-archive-field",
            },
        ]
        for request in invalid_requests:
            with self.subTest(command=request["command"], action=request.get("action")):
                with self.assertRaisesRegex(
                    gateway_module.GatewayError,
                    "Unexpected request fields",
                ):
                    self.gateway.handle(request)

    def test_0149_uses_thread_scoped_account_usage_without_exposing_native_id(self) -> None:
        self.fake_state["userAgent"] = "codex_core_rs/0.149.0"
        session = self.discover()
        usage = self.gateway.handle(
            {
                "command": "codex_account_usage",
                "sessionRef": session["sessionRef"],
            }
        )
        self.assertEqual(usage["scope"], "thread_and_account")
        self.assertTrue(usage["threadSpecificNativeUsageAvailable"])
        thread_usage = usage["usage"]["threadUsage"]
        self.assertTrue(thread_usage["available"])
        self.assertEqual(thread_usage["estimatedUsageCreditsMicros"], 77)
        self.assertEqual(thread_usage["groups"][0]["totalTokens"], 120)
        serialized = json.dumps(usage, sort_keys=True)
        self.assertNotIn(self.thread_id, serialized)

        read = self.gateway.handle(
            {
                "command": "codex_session_read",
                "sessionRef": session["sessionRef"],
                "includeTurns": False,
                "includeUsage": True,
            }
        )
        self.assertTrue(read["session"]["threadUsage"]["available"])

    def test_live_projection_excludes_reasoning_and_raw_tool_output(self) -> None:
        channel = FakePersistentChannel()
        gateway = PersistentTestGateway(self.config, self.fake_state, channel)
        server = next(iter(gateway.servers.values()))
        reasoning = gateway._project_live_notification(
            server,
            "item/reasoning/textDelta",
            {
                "threadId": self.thread_id,
                "turnId": "turn-private",
                "delta": "private reasoning content",
            },
            1,
        )
        self.assertIsNone(reasoning)
        output = gateway._project_live_notification(
            server,
            "item/commandExecution/outputDelta",
            {
                "threadId": self.thread_id,
                "turnId": "turn-private",
                "delta": "credential=sk-privatefixture123456789",
            },
            1,
        )
        serialized = json.dumps(output, sort_keys=True)
        self.assertNotIn("sk-privatefixture123456789", serialized)
        self.assertTrue(output["contentOmitted"])
        message = gateway._project_live_notification(
            server,
            "item/agentMessage/delta",
            {
                "threadId": self.thread_id,
                "turnId": "turn-private",
                "delta": "token=sk-privatefixture123456789",
            },
            1,
        )
        self.assertIn("[REDACTED_TOKEN]", message["text"])

    def test_live_events_and_approval_list_use_persistent_channel(self) -> None:
        approval_ref = "cdx_apr_" + "a" * 32
        projected = {
            "approvalRef": approval_ref,
            "method": "item/fileChange/requestApproval",
            "status": "pending",
            "createdAt": "2026-08-21T00:00:00Z",
            "responseConfirmed": False,
            "kind": "file_change_approval",
            "serverRef": "cdx_srv_" + "b" * 32,
            "sessionRef": "cdx_ses_" + "c" * 32,
            "turnRef": "cdx_turn_" + "d" * 32,
            "requestDigestSha256": "e" * 64,
            "rawParams": {},
            "projection": {},
        }
        channel = FakePersistentChannel(projected)
        gateway = PersistentTestGateway(self.config, self.fake_state, channel)
        server = next(iter(gateway.servers.values()))
        events = gateway.handle(
            {
                "command": "codex_live_events",
                "serverRef": server["serverRef"],
                "afterSequence": 0,
                "limit": 10,
            }
        )
        self.assertEqual(events["events"][0]["kind"], "native_notification")
        approvals = gateway.handle(
            {
                "command": "codex_approval_list",
                "serverRef": server["serverRef"],
            }
        )
        self.assertEqual(approvals["approvals"][0]["approvalRef"], approval_ref)
        self.assertFalse(approvals["policy"]["autoApproval"])

    def test_command_approval_requires_scope_ack_and_replays_idempotently(self) -> None:
        server = next(iter(self.gateway.servers.values()))
        session_ref = gateway_module.opaque_ref(
            "cdx_ses", server["serverAlias"], self.thread_id
        )
        turn_ref = gateway_module.opaque_ref(
            "cdx_turn", session_ref, "turn-private"
        )
        approval_ref = "cdx_apr_" + "f" * 32
        projected = {
            "approvalRef": approval_ref,
            "method": "item/commandExecution/requestApproval",
            "status": "pending",
            "createdAt": "2026-08-21T00:00:00Z",
            "responseConfirmed": False,
            "kind": "command_approval",
            "serverRef": server["serverRef"],
            "sessionRef": session_ref,
            "turnRef": turn_ref,
            "requestDigestSha256": "1" * 64,
            "rawParams": {
                "threadId": self.thread_id,
                "turnId": "turn-private",
                "itemId": "item-private",
                "command": "printf fixture",
            },
            "projection": {
                "kind": "command_approval",
                "serverRef": server["serverRef"],
                "sessionRef": session_ref,
                "turnRef": turn_ref,
                "requestDigestSha256": "1" * 64,
            },
        }
        channel = FakePersistentChannel(projected)
        gateway = PersistentTestGateway(self.config, self.fake_state, channel)
        base = {
            "command": "codex_approval_respond",
            "approvalRef": approval_ref,
            "decision": "acceptForSession",
            "idempotencyKey": "approval-session-test",
        }
        with self.assertRaisesRegex(
            gateway_module.GatewayError,
            "acknowledgeSessionWideApproval",
        ):
            gateway.handle(base)
        request = {**base, "acknowledgeSessionWideApproval": True}
        first = gateway.handle(request)
        second = gateway.handle(request)
        self.assertEqual(first["state"], "succeeded")
        self.assertTrue(second["idempotentReplay"])
        self.assertEqual(
            channel.responses[0]["result"],
            {"decision": "acceptForSession"},
        )
        serialized = json.dumps(first, sort_keys=True)
        self.assertNotIn(self.thread_id, serialized)
        self.assertNotIn("printf fixture", serialized)

    def test_secret_user_input_and_sensitive_elicitation_are_rejected(self) -> None:
        server = next(iter(self.gateway.servers.values()))
        session_ref = gateway_module.opaque_ref(
            "cdx_ses", server["serverAlias"], self.thread_id
        )
        turn_ref = gateway_module.opaque_ref(
            "cdx_turn", session_ref, "turn-private"
        )
        secret_ref = "cdx_apr_" + "2" * 32
        secret = {
            "approvalRef": secret_ref,
            "method": "item/tool/requestUserInput",
            "status": "pending",
            "createdAt": "2026-08-21T00:00:00Z",
            "responseConfirmed": False,
            "kind": "user_input",
            "serverRef": server["serverRef"],
            "sessionRef": session_ref,
            "turnRef": turn_ref,
            "requestDigestSha256": "3" * 64,
            "rawParams": {
                "threadId": self.thread_id,
                "turnId": "turn-private",
                "itemId": "item-private",
                "questions": [
                    {
                        "id": "credential",
                        "header": "Credential",
                        "question": "Provide credential",
                        "isSecret": True,
                    }
                ],
            },
            "projection": {
                "kind": "user_input",
                "serverRef": server["serverRef"],
                "sessionRef": session_ref,
                "turnRef": turn_ref,
                "requestDigestSha256": "3" * 64,
            },
        }
        secret_gateway = PersistentTestGateway(
            self.config,
            self.fake_state,
            FakePersistentChannel(secret),
        )
        with self.assertRaisesRegex(
            gateway_module.GatewayError,
            "Secret Codex user-input questions",
        ):
            secret_gateway.handle(
                {
                    "command": "codex_approval_respond",
                    "approvalRef": secret_ref,
                    "decision": "answer",
                    "answers": {"credential": ["fixture-value"]},
                    "idempotencyKey": "secret-answer-test",
                }
            )

        elicitation_ref = "cdx_apr_" + "4" * 32
        elicitation = {
            "approvalRef": elicitation_ref,
            "method": "mcpServer/elicitation/request",
            "status": "pending",
            "createdAt": "2026-08-21T00:00:00Z",
            "responseConfirmed": False,
            "kind": "mcp_elicitation",
            "serverRef": server["serverRef"],
            "sessionRef": session_ref,
            "turnRef": turn_ref,
            "requestDigestSha256": "5" * 64,
            "rawParams": {
                "threadId": self.thread_id,
                "turnId": "turn-private",
                "serverName": "fixture",
                "mode": "form",
                "message": "fixture form",
            },
            "projection": {
                "kind": "mcp_elicitation",
                "serverRef": server["serverRef"],
                "sessionRef": session_ref,
                "turnRef": turn_ref,
                "requestDigestSha256": "5" * 64,
            },
        }
        elicitation_gateway = PersistentTestGateway(
            self.config,
            self.fake_state,
            FakePersistentChannel(elicitation),
        )
        with self.assertRaisesRegex(
            gateway_module.GatewayError,
            "Sensitive elicitation fields",
        ):
            elicitation_gateway.handle(
                {
                    "command": "codex_approval_respond",
                    "approvalRef": elicitation_ref,
                    "decision": "accept",
                    "content": {"password": "fixture-value"},
                    "idempotencyKey": "sensitive-elicitation-test",
                }
            )

    def test_policy_amendment_must_match_native_proposal_exactly(self) -> None:
        raw = {
            "approvalRef": "cdx_apr_" + "6" * 32,
            "method": "item/commandExecution/requestApproval",
            "rawParams": {
                "threadId": self.thread_id,
                "turnId": "turn-private",
                "itemId": "item-private",
                "proposedExecpolicyAmendment": ["prefix_rule()"],
                "proposedNetworkPolicyAmendments": [
                    {"host": "example.test", "action": "allow"}
                ],
            },
            "projection": {
                "requestDigestSha256": "7" * 64,
                "sessionRef": "cdx_ses_" + "8" * 32,
                "turnRef": "cdx_turn_" + "9" * 32,
            },
        }
        with self.assertRaisesRegex(
            gateway_module.GatewayError,
            "exactly match the amendment proposed",
        ):
            self.gateway._approval_response_payload(
                {
                    "decision": "acceptWithExecpolicyAmendment",
                    "acknowledgePolicyAmendment": True,
                    "execpolicyAmendment": ["different_rule()"],
                },
                raw,
            )
        result, error, intent = self.gateway._approval_response_payload(
            {
                "decision": "acceptWithExecpolicyAmendment",
                "acknowledgePolicyAmendment": True,
                "execpolicyAmendment": ["prefix_rule()"],
            },
            raw,
        )
        self.assertIsNone(error)
        self.assertEqual(
            result,
            {
                "decision": {
                    "acceptWithExecpolicyAmendment": {
                        "execpolicy_amendment": ["prefix_rule()"],
                    }
                }
            },
        )
        self.assertTrue(intent["policyAmendmentAcknowledged"])

        with self.assertRaisesRegex(
            gateway_module.GatewayError,
            "exactly match one amendment proposed",
        ):
            self.gateway._approval_response_payload(
                {
                    "decision": "applyNetworkPolicyAmendment",
                    "acknowledgePolicyAmendment": True,
                    "networkPolicyAmendment": {
                        "host": "other.test",
                        "action": "allow",
                    },
                },
                raw,
            )

    def test_typed_mcp_elicitation_content_is_schema_validated(self) -> None:
        raw = {
            "approvalRef": "cdx_apr_" + "a" * 32,
            "method": "mcpServer/elicitation/request",
            "rawParams": {
                "threadId": self.thread_id,
                "turnId": "turn-private",
                "serverName": "fixture",
                "mode": "form",
                "message": "fixture form",
                "requestedSchema": {
                    "type": "object",
                    "properties": {
                        "choice": {
                            "type": "string",
                            "enum": ["one", "two"],
                        },
                        "count": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 5,
                        },
                    },
                    "required": ["choice", "count"],
                },
            },
            "projection": {
                "requestDigestSha256": "b" * 64,
                "sessionRef": "cdx_ses_" + "c" * 32,
                "turnRef": "cdx_turn_" + "d" * 32,
            },
        }
        result, error, _intent = self.gateway._approval_response_payload(
            {
                "decision": "accept",
                "content": {"choice": "two", "count": 3},
            },
            raw,
        )
        self.assertIsNone(error)
        self.assertEqual(
            result,
            {"action": "accept", "content": {"choice": "two", "count": 3}},
        )
        with self.assertRaisesRegex(
            gateway_module.GatewayError,
            "not an allowed option",
        ):
            self.gateway._approval_response_payload(
                {
                    "decision": "accept",
                    "content": {"choice": "three", "count": 3},
                },
                raw,
            )
        with self.assertRaisesRegex(
            gateway_module.GatewayError,
            "outside the requested schema",
        ):
            self.gateway._approval_response_payload(
                {
                    "decision": "accept",
                    "content": {"choice": "one", "count": 2, "extra": True},
                },
                raw,
            )

    def test_exact_protocol_profiles_are_validated_and_unknown_effects_fail_closed(self) -> None:
        for version in (
            "0.147.0",
            "0.147.0-alpha.6.6",
            "0.149.0",
        ):
            profile = gateway_module._protocol_profile(
                {"userAgent": f"codex_core_rs/{version}"}
            )
            self.assertEqual(profile["protocolVersion"], version)
            self.assertTrue(profile["effectsValidated"])
            self.assertEqual(profile["effectCompatibility"], "validated")
            self.assertIn("turn/start", profile["validatedClientMethods"])
            self.assertIn(
                "item/commandExecution/requestApproval",
                profile["validatedInteractiveServerRequests"],
            )

        unknown_profile = gateway_module._protocol_profile(
            {"userAgent": "codex_core_rs/0.150.0"}
        )
        self.assertFalse(unknown_profile["effectsValidated"])
        self.assertEqual(unknown_profile["effectCompatibility"], "blocked")

        session = self.discover()
        channel = FakePersistentChannel(user_agent="codex_core_rs/0.150.0")
        gateway = PersistentTestGateway(self.config, self.fake_state, channel)
        with self.assertRaisesRegex(
            gateway_module.GatewayError,
            "exact Codex App Server protocol profile",
        ):
            gateway.handle(
                {
                    "command": "codex_turn_control",
                    "action": "submit",
                    "sessionRef": session["sessionRef"],
                    "message": "fixture message",
                    "idempotencyKey": "unknown-protocol-test",
                }
            )
        self.assertEqual(channel.responses, [])


if __name__ == "__main__":
    unittest.main()

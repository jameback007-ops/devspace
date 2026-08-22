from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from chatgpt_langchain_bridge.durability import (
    DurableMaterialConfig,
    DurableMaterialExecutor,
    NativeDurabilityPolicy,
)
from chatgpt_langchain_bridge.registry import BridgeConfig, WorkspaceRegistry
from chatgpt_langchain_bridge.worktree import WorktreeBinding


@dataclass(frozen=True)
class FakeWorkstream:
    workstream_ref: str = "workstream-a"
    agent_thread_id: str = "thread-native-a"

    def public_view(self) -> dict[str, Any]:
        return {
            "workstream_ref": self.workstream_ref,
            "agent_thread_id": self.agent_thread_id,
        }


class FakeRuns:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []

    def create(
        self,
        thread_id: str,
        assistant_id: str,
        *,
        input: dict[str, Any] | None = None,
        stream_mode: str | None = None,
        stream_resumable: bool | None = None,
        durability: str | None = None,
        on_disconnect: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.created.append(
            {
                "thread_id": thread_id,
                "assistant_id": assistant_id,
                "input": input,
                "stream_mode": stream_mode,
                "stream_resumable": stream_resumable,
                "durability": durability,
                "on_disconnect": on_disconnect,
                "metadata": metadata,
            }
        )
        return {"run_id": "run-material-1", "status": "pending"}

    def join(self, thread_id: str, run_id: str) -> dict[str, Any]:
        return {
            "path": "value.txt",
            "error": None,
            "durable_status": "applied",
            "thread_id": thread_id,
            "run_id": run_id,
        }


class FakeClient:
    def __init__(self) -> None:
        self.runs = FakeRuns()


def make_managed_registry(tmp_path: Path) -> tuple[WorkspaceRegistry, str, FakeClient]:
    worktree = tmp_path / "worktree"
    worktree.mkdir()
    (worktree / "value.txt").write_text("before\n", encoding="utf-8")
    registry = WorkspaceRegistry(
        BridgeConfig(allowed_roots=((tmp_path / "other").resolve(),))
    )
    binding = WorktreeBinding(
        schema_version="chatgpt-langchain-worktree-binding.v1",
        repository_alias="zes",
        workstream_ref="workstream-a",
        repository_root=str((tmp_path / "source").resolve()),
        worktree_root=str(tmp_path.resolve()),
        worktree_path=str(worktree.resolve()),
        branch="agent/webchat/zes/1234",
        base_ref="main",
        head_sha="a" * 40,
        created_at="2026-08-23T00:00:00+00:00",
        binding_source="test",
    )
    opened = registry.open_worktree(  # type: ignore[arg-type]
        binding,
        workstream=FakeWorkstream(),
    )
    client = FakeClient()
    return registry, opened["workspace_id"], client


def test_native_durability_policy_does_not_guess_raw_shell_effects() -> None:
    policy = NativeDurabilityPolicy()

    mutation = policy.classify("edit_file", managed_worktree=True)
    shell = policy.classify("execute", managed_worktree=True)
    read = policy.classify("read_file", managed_worktree=True)

    assert mutation.durability == "sync"
    assert mutation.on_disconnect == "continue"
    assert mutation.execution_path == "agent_server_functional_api_run"
    assert shell.execution_path == "direct_until_explicit_operation_class_exists"
    assert shell.idempotency_policy == "never_infer_from_raw_command"
    assert shell.mcp_tasks_preferred is True
    assert read.durability == "direct"


def test_managed_worktree_edit_creates_native_sync_durable_run(tmp_path: Path) -> None:
    registry, workspace_id, client = make_managed_registry(tmp_path)
    executor = DurableMaterialExecutor(
        registry,
        DurableMaterialConfig(
            enabled=True,
            agent_server_url="http://agent-server.test",
            assistant_id="bridge_material_operation",
        ),
        client_factory=lambda **_: client,
    )

    result = executor.edit_file(
        workspace_id,
        "value.txt",
        "before",
        "after",
        False,
    )

    assert result["durable_status"] == "applied"
    created = client.runs.created[0]
    assert created["thread_id"] == "thread-native-a"
    assert created["assistant_id"] == "bridge_material_operation"
    assert created["durability"] == "sync"
    assert created["on_disconnect"] == "continue"
    assert created["stream_resumable"] is True
    assert created["input"]["operation"] == "edit"
    assert created["input"]["before_sha256"] != created["input"]["after_sha256"]
    assert created["metadata"]["bridge_workstream_ref"] == "workstream-a"


def test_non_worktree_mutation_remains_direct(tmp_path: Path) -> None:
    workspace = tmp_path / "fixture"
    workspace.mkdir()
    (workspace / "value.txt").write_text("before\n", encoding="utf-8")
    registry = WorkspaceRegistry(BridgeConfig(allowed_roots=(workspace.resolve(),)))
    workspace_id = registry.open(str(workspace))["workspace_id"]
    executor = DurableMaterialExecutor(
        registry,
        DurableMaterialConfig(
            enabled=True,
            agent_server_url="http://agent-server.test",
        ),
        client_factory=lambda **_: FakeClient(),
    )

    result = executor.edit_file(
        workspace_id,
        "value.txt",
        "before",
        "after",
        False,
    )

    assert result["error"] is None
    assert (workspace / "value.txt").read_text(encoding="utf-8") == "after\n"

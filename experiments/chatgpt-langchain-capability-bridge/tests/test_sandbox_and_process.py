from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest

from chatgpt_langchain_bridge.process_plane import ProcessPlane
from chatgpt_langchain_bridge.registry import (
    BridgeConfig,
    BridgeError,
    WorkspaceRegistry,
)
from chatgpt_langchain_bridge.sandbox_plane import SandboxPlane, SandboxPlaneConfig
from chatgpt_langchain_bridge.sandbox_plane import (
    LangSmithProviderConfig,
    LangSmithSandboxProvider,
)


@dataclass
class FakeExecutionResult:
    stdout: str
    stderr: str
    exit_code: int


class FakeCommandHandle:
    def __init__(
        self,
        command_id: str,
        chunks: list[tuple[str, str, int]],
        delay_seconds: float = 0,
    ) -> None:
        self.command_id = command_id
        self.pid = 42
        self.last_stdout_offset = 0
        self.last_stderr_offset = 0
        self._chunks = chunks
        self._delay_seconds = delay_seconds
        self.inputs: list[str] = []
        self.killed = False
        self.result = FakeExecutionResult(stdout="", stderr="", exit_code=0)

    def __iter__(self):
        stdout: list[str] = []
        stderr: list[str] = []
        if self._delay_seconds:
            time.sleep(self._delay_seconds)
        for stream, data, offset in self._chunks:
            if stream == "stdout":
                stdout.append(data)
                self.last_stdout_offset = offset + len(data.encode("utf-8"))
            else:
                stderr.append(data)
                self.last_stderr_offset = offset + len(data.encode("utf-8"))
            yield SimpleNamespace(stream=stream, data=data, offset=offset)
        self.result = FakeExecutionResult(
            stdout="".join(stdout), stderr="".join(stderr), exit_code=0
        )

    def send_input(self, data: str) -> None:
        self.inputs.append(data)

    def kill(self) -> None:
        self.killed = True


class FakeSandbox:
    def __init__(self, name: str) -> None:
        self.name = name
        self.id = f"id-{name}"
        self.status = "ready"
        self.status_message = None
        self.created_at = "2026-08-22T00:00:00Z"
        self.updated_at = self.created_at
        self.idle_ttl_seconds = 900
        self.delete_after_stop_seconds = 3600
        self.stopped_at = None
        self.snapshot_id = "snapshot-allowed"
        self.vcpus = 2
        self.mem_bytes = 1024
        self.fs_capacity_bytes = 4096
        self.handles: dict[str, FakeCommandHandle] = {}
        self.delay_seconds = 0.0

    def run(self, command: str, **kwargs):
        if kwargs.get("wait", True):
            return FakeExecutionResult(stdout="ok", stderr="", exit_code=0)
        handle = FakeCommandHandle(
            "command-native-1",
            [("stdout", "first\n", 0), ("stderr", "warn\n", 0)],
            delay_seconds=self.delay_seconds,
        )
        self.handles[handle.command_id] = handle
        return handle

    def reconnect(
        self,
        command_id: str,
        *,
        stdout_offset: int = 0,
        stderr_offset: int = 0,
    ) -> FakeCommandHandle:
        return FakeCommandHandle(
            command_id,
            [("stdout", "resumed\n", stdout_offset)],
        )


class FakeSandboxClient:
    def __init__(self) -> None:
        self.sandboxes: dict[str, FakeSandbox] = {}
        self.stopped: list[str] = []
        self.deleted: list[str] = []

    def list_sandboxes(self):
        return list(self.sandboxes.values())

    def create_sandbox(self, snapshot_id=None, **kwargs):
        sandbox = FakeSandbox(kwargs["name"])
        sandbox.snapshot_id = snapshot_id or kwargs.get("snapshot_name")
        self.sandboxes[sandbox.name] = sandbox
        return sandbox

    def get_sandbox(self, name: str):
        return self.sandboxes[name]

    def get_sandbox_status(self, name: str):
        return SimpleNamespace(status=self.sandboxes[name].status, status_message=None)

    def stop_sandbox(self, name: str) -> None:
        self.stopped.append(name)

    def delete_sandbox(self, name: str) -> None:
        self.deleted.append(name)
        self.sandboxes.pop(name, None)


def make_planes(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("LANGSMITH_API_KEY", "bound-but-never-printed")
    registry = WorkspaceRegistry(BridgeConfig(allowed_roots=(tmp_path,)))
    client = FakeSandboxClient()
    provider = LangSmithSandboxProvider(
        LangSmithProviderConfig(
            name_prefix="zes-test-",
            allowed_snapshot_ids=("snapshot-allowed",),
        ),
        client_factory=lambda: client,
    )
    config = SandboxPlaneConfig(
        provider_id="langsmith",
        default_workspace_root="/workspace",
    )
    sandboxes = SandboxPlane(
        registry,
        config,
        providers={"langsmith": provider},
    )
    return registry, client, sandboxes


def test_native_sandbox_lifecycle_attaches_as_workspace(
    tmp_path: Path, monkeypatch
) -> None:
    registry, client, sandboxes = make_planes(tmp_path, monkeypatch)

    created = sandboxes.operate(
        "create",
        sandbox_name="zes-test-one",
        snapshot_id="snapshot-allowed",
        workspace_root="/workspace",
    )
    workspace_id = created["workspace"]["workspace_id"]

    assert created["workspace"]["backend"] == "deepagents.LangSmithSandbox"
    assert registry.status(workspace_id)["persistent_process"] is True
    assert sandboxes.operate("list")["sandboxes"][0]["name"] == "zes-test-one"
    assert (
        sandboxes.operate("status", sandbox_name="zes-test-one")["status"]["status"]
        == "ready"
    )
    assert client.sandboxes["zes-test-one"].snapshot_id == "snapshot-allowed"

    detached = sandboxes.operate("detach", workspace_id=workspace_id)
    assert detached["detached"] is True


def test_sandbox_create_requires_allowlisted_snapshot(
    tmp_path: Path, monkeypatch
) -> None:
    _, _, sandboxes = make_planes(tmp_path, monkeypatch)

    with pytest.raises(BridgeError, match="allowlist"):
        sandboxes.operate(
            "create",
            sandbox_name="zes-test-denied",
            snapshot_id="snapshot-denied",
        )


def test_process_plane_uses_native_command_handle_and_resume(
    tmp_path: Path, monkeypatch
) -> None:
    registry, _, sandboxes = make_planes(tmp_path, monkeypatch)
    created = sandboxes.operate(
        "create",
        sandbox_name="zes-test-process",
        snapshot_id="snapshot-allowed",
    )
    workspace_id = created["workspace"]["workspace_id"]
    processes = ProcessPlane(registry, sandboxes)

    started = processes.operate(
        "start",
        workspace_id=workspace_id,
        command="pytest -q",
        pty=True,
    )
    deadline = time.monotonic() + 2
    polled = processes.operate("poll", process_id=started["process_id"])
    while polled["status"] == "running" and time.monotonic() < deadline:
        time.sleep(0.01)
        polled = processes.operate("poll", process_id=started["process_id"])

    assert polled["status"] == "completed"
    assert [event["stream"] for event in polled["events"]] == ["stdout", "stderr"]
    assert polled["last_stdout_offset"] == len(b"first\n")
    assert "command_sha256" not in polled

    fresh_process_plane = ProcessPlane(registry, sandboxes)
    resumed = fresh_process_plane.operate(
        "resume",
        workspace_id=workspace_id,
        process_id="command-existing",
        stdout_offset=12,
    )
    assert resumed["process_id"] == "command-existing"


def test_process_poll_can_wait_for_new_native_output(
    tmp_path: Path, monkeypatch
) -> None:
    registry, client, sandboxes = make_planes(tmp_path, monkeypatch)
    created = sandboxes.operate(
        "create",
        sandbox_name="zes-test-long-poll",
        snapshot_id="snapshot-allowed",
    )
    workspace_id = created["workspace"]["workspace_id"]
    client.sandboxes["zes-test-long-poll"].delay_seconds = 0.05
    processes = ProcessPlane(registry, sandboxes)
    started = processes.operate(
        "start",
        workspace_id=workspace_id,
        command="long-running-command",
    )

    started_at = time.monotonic()
    polled = processes.operate(
        "poll",
        process_id=started["process_id"],
        after_sequence=0,
        wait_seconds=1,
    )
    elapsed = time.monotonic() - started_at

    assert elapsed >= 0.03
    assert polled["events"][0]["data"] == "first\n"
    assert polled["wait_seconds"] == 1.0


def test_process_rejects_local_shell_workspace(tmp_path: Path, monkeypatch) -> None:
    registry, _, sandboxes = make_planes(tmp_path, monkeypatch)
    local_workspace = registry.open(str(tmp_path))["workspace_id"]

    with pytest.raises(BridgeError, match="native sandbox provider"):
        ProcessPlane(registry, sandboxes).operate(
            "start",
            workspace_id=local_workspace,
            command="sleep 1",
        )

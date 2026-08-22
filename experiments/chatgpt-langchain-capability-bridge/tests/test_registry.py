from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from chatgpt_langchain_bridge.registry import (
    BridgeConfig,
    BridgeError,
    WorkspaceRegistry,
)
from chatgpt_langchain_bridge.workstream import WorkstreamBinding


def make_registry(root: Path) -> WorkspaceRegistry:
    return WorkspaceRegistry(
        BridgeConfig(
            allowed_roots=(root.resolve(),),
            command_timeout_seconds=30,
            safe_environment=(("PATH", "/usr/local/bin:/usr/bin:/bin"),),
        )
    )


def test_native_backend_supports_coding_loop(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "maths.py").write_text(
        "def add(a: int, b: int) -> int:\n    return a - b\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "add", "src/maths.py"], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(tmp_path),
            "-c",
            "user.name=Bridge Test",
            "-c",
            "user.email=bridge-test@example.invalid",
            "commit",
            "-qm",
            "initial fixture",
        ],
        check=True,
    )

    registry = make_registry(tmp_path)
    workspace = registry.open(str(tmp_path))
    workspace_id = workspace["workspace_id"]

    assert registry.ls(workspace_id, "src")["error"] is None
    assert (
        "return a - b"
        in registry.read(workspace_id, "src/maths.py")["file_data"]["content"]
    )
    assert registry.grep(workspace_id, "return", "src")["matches"]

    edit = registry.edit(
        workspace_id,
        "src/maths.py",
        "return a - b",
        "return a + b",
    )
    assert edit["error"] is None

    execution = registry.execute(
        workspace_id,
        'python3 -c "from src.maths import add; assert add(2, 3) == 5"',
    )
    assert execution["exit_code"] == 0

    git_diff = registry.execute(workspace_id, "git diff -- src/maths.py")
    assert "return a + b" in git_diff["output"]


def test_file_tools_reject_escape_and_absolute_paths(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    workspace_id = registry.open(str(tmp_path))["workspace_id"]

    with pytest.raises(BridgeError, match="workspace-relative"):
        registry.read(workspace_id, "/etc/passwd")

    with pytest.raises(BridgeError, match="escapes"):
        registry.read(workspace_id, "../outside.txt")


def test_workspace_must_be_under_allowed_root(tmp_path: Path) -> None:
    allowed = tmp_path / "allowed"
    denied = tmp_path / "denied"
    allowed.mkdir()
    denied.mkdir()
    registry = make_registry(allowed)

    with pytest.raises(BridgeError, match="outside allowed roots"):
        registry.open(str(denied))


def test_same_root_supports_distinct_workstream_handles(tmp_path: Path) -> None:
    registry = make_registry(tmp_path)
    first_binding = WorkstreamBinding(
        workstream_ref="workstream-a",
        trace_thread_id="workstream-a",
        source="webchat_supplied",
        state="local_trace_only",
        bound_at="2026-08-22T00:00:00+00:00",
    )
    second_binding = WorkstreamBinding(
        workstream_ref="workstream-b",
        trace_thread_id="workstream-b",
        source="webchat_supplied",
        state="local_trace_only",
        bound_at="2026-08-22T00:00:00+00:00",
    )

    first = registry.open(str(tmp_path), workstream=first_binding)
    first_again = registry.open(str(tmp_path), workstream=first_binding)
    second = registry.open(str(tmp_path), workstream=second_binding)

    assert first_again["workspace_id"] == first["workspace_id"]
    assert second["workspace_id"] != first["workspace_id"]
    assert first["workstream"]["workstream_ref"] == "workstream-a"
    assert second["workstream"]["workstream_ref"] == "workstream-b"

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from chatgpt_langchain_bridge.registry import (
    BridgeConfig,
    BridgeError,
    WorkspaceRegistry,
)
from chatgpt_langchain_bridge.worktree import (
    WORKTREE_BINDING_SCHEMA,
    WorktreeBindingConfig,
    WorktreeBindingManager,
    WorktreeRepository,
)


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


class MemoryBindingStore:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str], dict[str, Any]] = {}

    def get(self, repository_alias: str, workstream_ref: str) -> dict[str, Any] | None:
        value = self.values.get((repository_alias, workstream_ref))
        return dict(value) if value else None

    def put(
        self,
        repository_alias: str,
        workstream_ref: str,
        binding: dict[str, Any],
    ) -> None:
        self.values[(repository_alias, workstream_ref)] = dict(binding)


@dataclass(frozen=True)
class FakeWorkstream:
    workstream_ref: str

    def public_view(self) -> dict[str, Any]:
        return {"workstream_ref": self.workstream_ref}


def make_repository(tmp_path: Path) -> tuple[Path, Path]:
    repository = tmp_path / "source"
    repository.mkdir()
    git(repository, "init", "-b", "main")
    git(repository, "config", "user.name", "ZES Worktree Test")
    git(repository, "config", "user.email", "zes-worktree@example.invalid")
    (repository / "value.txt").write_text("baseline\n", encoding="utf-8")
    (repository / "verify.py").write_text(
        "from pathlib import Path\n"
        "assert Path('value.txt').read_text() in {'baseline\\n', 'lane-a\\n'}\n",
        encoding="utf-8",
    )
    git(repository, "add", ".")
    git(repository, "commit", "-m", "fixture")
    return repository.resolve(), (tmp_path / "worktrees").resolve()


def make_manager(
    repository: Path,
    worktree_root: Path,
    lock_root: Path,
    store: MemoryBindingStore,
) -> WorktreeBindingManager:
    return WorktreeBindingManager(
        config=WorktreeBindingConfig(
            repositories=(
                WorktreeRepository(
                    alias="zes",
                    repository_root=repository,
                    worktree_root=worktree_root,
                    base_ref="main",
                    branch_prefix="agent/webchat",
                ),
            ),
            lock_root=lock_root,
        ),
        store=store,
    )


def test_workstream_resolves_to_stable_native_git_worktree(tmp_path: Path) -> None:
    repository, worktree_root = make_repository(tmp_path)
    store = MemoryBindingStore()
    manager = make_manager(repository, worktree_root, tmp_path / "locks", store)

    first = manager.resolve("zes-worktree://zes", "workstream-a")
    repeated = make_manager(
        repository, worktree_root, tmp_path / "locks", store
    ).resolve("zes-worktree://zes", "workstream-a")

    assert first.schema_version == WORKTREE_BINDING_SCHEMA
    assert first.worktree_path == repeated.worktree_path
    assert first.branch == repeated.branch
    assert Path(first.worktree_path).is_dir()
    assert git(Path(first.worktree_path), "branch", "--show-current") == first.branch
    assert repeated.binding_source == "agent_server_store_reconciled_with_git"


def test_distinct_workstreams_receive_isolated_git_worktrees(tmp_path: Path) -> None:
    repository, worktree_root = make_repository(tmp_path)
    manager = make_manager(
        repository, worktree_root, tmp_path / "locks", MemoryBindingStore()
    )

    lane_a = manager.resolve("zes-worktree://zes", "workstream-a")
    lane_b = manager.resolve("zes-worktree://zes", "workstream-b")
    lane_a_root = Path(lane_a.worktree_path)
    lane_b_root = Path(lane_b.worktree_path)

    assert lane_a.worktree_path != lane_b.worktree_path
    assert lane_a.branch != lane_b.branch
    (lane_a_root / "value.txt").write_text("lane-a\n", encoding="utf-8")
    assert (lane_b_root / "value.txt").read_text(encoding="utf-8") == "baseline\n"
    assert git(lane_a_root, "status", "--short") == "M value.txt"
    assert git(lane_b_root, "status", "--short") == ""


def test_registry_opens_only_manager_authorized_worktree_with_exact_git_trust(
    tmp_path: Path,
) -> None:
    repository, worktree_root = make_repository(tmp_path)
    binding = make_manager(
        repository, worktree_root, tmp_path / "locks", MemoryBindingStore()
    ).resolve("zes-worktree://zes", "workstream-a")
    unrelated_allowed_root = tmp_path / "fixtures"
    unrelated_allowed_root.mkdir()
    registry = WorkspaceRegistry(
        BridgeConfig(allowed_roots=(unrelated_allowed_root.resolve(),))
    )
    workstream = FakeWorkstream("workstream-a")

    opened = registry.open_worktree(binding, workstream=workstream)  # type: ignore[arg-type]
    result = registry.execute(
        opened["workspace_id"],
        "git status --short && git config --get-all safe.directory && python3 verify.py",
        timeout=30,
    )

    assert result["exit_code"] == 0
    assert binding.worktree_path in result["output"]
    assert "*" not in result["output"].splitlines()
    assert opened["worktree_binding"]["branch"] == binding.branch

    with pytest.raises(BridgeError, match="outside allowed roots"):
        registry.open(binding.worktree_path, workstream=workstream)  # type: ignore[arg-type]


def test_stored_binding_conflict_fails_closed(tmp_path: Path) -> None:
    repository, worktree_root = make_repository(tmp_path)
    store = MemoryBindingStore()
    manager = make_manager(repository, worktree_root, tmp_path / "locks", store)
    binding = manager.resolve("zes-worktree://zes", "workstream-a")
    store.values[("zes", "workstream-a")]["worktree_path"] = str(tmp_path / "other")

    with pytest.raises(BridgeError, match="conflicts on worktree_path"):
        manager.resolve("zes-worktree://zes", "workstream-a")

    assert Path(binding.worktree_path).is_dir()

from __future__ import annotations

import hashlib
import os
from dataclasses import asdict
from pathlib import Path, PurePosixPath
from typing import Any

from deepagents.backends import LocalShellBackend
from langgraph.config import get_store
from langgraph.func import entrypoint, task

from .registry import BridgeError
from .worktree import (
    WorktreeBindingConfig,
    WorktreeBindingManager,
    WorktreeBindingStore,
)


class RuntimeStoreWorktreeBindingStore(WorktreeBindingStore):
    """Read the same native Store namespace from inside an Agent Server run."""

    def __init__(self) -> None:
        self._prefix = tuple(
            item.strip()
            for item in os.environ.get(
                "BRIDGE_AGENT_SERVER_STORE_PREFIX", "chatgpt-langchain-bridge"
            ).split("/")
            if item.strip()
        )

    def get(self, repository_alias: str, workstream_ref: str) -> dict[str, Any] | None:
        item = get_store().get(self._namespace(repository_alias), workstream_ref)
        return dict(item.value) if item is not None else None

    def put(
        self,
        repository_alias: str,
        workstream_ref: str,
        binding: dict[str, Any],
    ) -> None:
        get_store().put(self._namespace(repository_alias), workstream_ref, binding)

    def _namespace(self, repository_alias: str) -> tuple[str, ...]:
        return (*self._prefix, "worktree-bindings", repository_alias)


def _digest(value: bytes | None) -> str | None:
    return hashlib.sha256(value).hexdigest() if value is not None else None


def _target(root: Path, relative_path: str) -> Path:
    path = PurePosixPath(relative_path)
    if path.is_absolute() or ".." in path.parts:
        raise BridgeError("durable material path must be worktree-relative")
    target = (root / Path(path.as_posix())).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError as exc:
        raise BridgeError("durable material path escapes assigned worktree") from exc
    return target


@task
def apply_material_operation(payload: dict[str, Any]) -> dict[str, Any]:
    manager = WorktreeBindingManager(
        config=WorktreeBindingConfig.from_environment(),
        store=RuntimeStoreWorktreeBindingStore(),
    )
    alias = str(payload["repository_alias"])
    workstream_ref = str(payload["workstream_ref"])
    binding = manager.resolve(f"zes-worktree://{alias}", workstream_ref)
    root = Path(binding.worktree_path).resolve()
    relative_path = str(payload["file_path"])
    target = _target(root, relative_path)
    current = target.read_bytes() if target.exists() else None
    before_sha = payload.get("before_sha256")
    after_sha = payload.get("after_sha256")

    if _digest(current) == after_sha:
        return {
            "path": relative_path,
            "error": None,
            "durable_status": "already_applied",
            "operation_id": payload["operation_id"],
        }
    if _digest(current) != before_sha:
        raise BridgeError(
            "durable material operation conflicts with current worktree content"
        )

    safe_environment = {
        key: os.environ[key]
        for key in (
            "PATH",
            "LANG",
            "LC_ALL",
            "TERM",
            "UV_CACHE_DIR",
            "PIP_CACHE_DIR",
            "NPM_CONFIG_CACHE",
        )
        if key in os.environ
    }
    safe_environment.update(
        {
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "safe.directory",
            "GIT_CONFIG_VALUE_0": str(root),
        }
    )
    backend = LocalShellBackend(
        root_dir=root,
        virtual_mode=False,
        timeout=int(os.environ.get("BRIDGE_COMMAND_TIMEOUT_SECONDS", "120")),
        max_output_bytes=int(os.environ.get("BRIDGE_MAX_OUTPUT_BYTES", "100000")),
        env=safe_environment,
        inherit_env=False,
    )
    operation = payload["operation"]
    if operation == "write":
        result = backend.write(relative_path, str(payload["content"]))
    elif operation == "edit":
        result = backend.edit(
            relative_path,
            str(payload["old_string"]),
            str(payload["new_string"]),
            replace_all=bool(payload.get("replace_all", False)),
        )
    elif operation == "delete":
        result = backend.delete(relative_path)
    else:
        raise BridgeError(f"unsupported durable material operation: {operation}")
    public = asdict(result)
    if public.get("error"):
        raise BridgeError(str(public["error"])[:500])
    final = target.read_bytes() if target.exists() else None
    if _digest(final) != after_sha:
        raise BridgeError("durable material operation terminal digest mismatch")
    return {
        **public,
        "durable_status": "applied",
        "operation_id": payload["operation_id"],
    }


@entrypoint()
def material_operation(payload: dict[str, Any]) -> dict[str, Any]:
    """One native durable run around one idempotent worktree mutation."""

    return apply_material_operation(payload).result()


graph = material_operation

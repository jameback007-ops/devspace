from __future__ import annotations

import hashlib
import os
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Any

from deepagents.backends import LocalShellBackend

from .tool_abi import ABI_FINGERPRINT_SHA256, ABI_TOOL_NAMES, ABI_VERSION


class BridgeError(ValueError):
    """A bounded, user-actionable bridge error."""


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


@dataclass(frozen=True)
class BridgeConfig:
    allowed_roots: tuple[Path, ...]
    command_timeout_seconds: int = 120
    max_output_bytes: int = 100_000
    safe_environment: tuple[tuple[str, str], ...] = ()

    @classmethod
    def from_environment(cls) -> BridgeConfig:
        raw_roots = os.environ.get("BRIDGE_ALLOWED_ROOTS", "").strip()
        if not raw_roots:
            raw_roots = os.getcwd()

        allowed_roots = tuple(
            Path(item.strip()).expanduser().resolve()
            for item in raw_roots.split(os.pathsep)
            if item.strip()
        )
        if not allowed_roots:
            raise BridgeError("BRIDGE_ALLOWED_ROOTS did not contain a usable path")

        safe_keys = (
            "PATH",
            "LANG",
            "LC_ALL",
            "TERM",
            "UV_CACHE_DIR",
            "PIP_CACHE_DIR",
            "NPM_CONFIG_CACHE",
        )
        safe_environment = tuple(
            (key, os.environ[key]) for key in safe_keys if key in os.environ
        )
        return cls(
            allowed_roots=allowed_roots,
            command_timeout_seconds=int(
                os.environ.get("BRIDGE_COMMAND_TIMEOUT_SECONDS", "120")
            ),
            max_output_bytes=int(os.environ.get("BRIDGE_MAX_OUTPUT_BYTES", "100000")),
            safe_environment=safe_environment,
        )


@dataclass
class WorkspaceHandle:
    workspace_id: str
    root: Path
    backend: LocalShellBackend
    opened_at: str

    def public_view(self) -> dict[str, Any]:
        return {
            "workspace_id": self.workspace_id,
            "root": str(self.root),
            "opened_at": self.opened_at,
            "backend": "deepagents.LocalShellBackend",
            "path_mode": "workspace_relative",
            "shell_boundary": "container_or_process_boundary",
        }


class WorkspaceRegistry:
    """Small transport registry over native Deep Agents backends.

    The bridge intentionally does not implement a second coding agent. ChatGPT
    owns the reasoning loop and calls these primitives directly through MCP.

    ``LocalShellBackend`` is not a sandbox. The production test topology must
    therefore run this process inside an isolated container or a supported
    remote Deep Agents sandbox. ``allowed_roots`` protects file-tool routing;
    the outer execution environment remains the shell security boundary.
    """

    def __init__(self, config: BridgeConfig):
        self._config = config
        self._workspaces: dict[str, WorkspaceHandle] = {}
        self._by_root: dict[Path, str] = {}
        self._lock = RLock()

    @property
    def config(self) -> BridgeConfig:
        return self._config

    def capability_manifest(self) -> dict[str, Any]:
        return {
            "schema_version": "chatgpt-langchain-capability-bridge.v1",
            "tool_abi": {
                "version": ABI_VERSION,
                "fingerprint_sha256": ABI_FINGERPRINT_SHA256,
                "tool_names": list(ABI_TOOL_NAMES),
                "compatibility_policy": (
                    "freeze names and required inputs during qualification; only "
                    "add optional inputs or change implementation behind the ABI"
                ),
            },
            "reasoning_owner": "chatgpt_webchat",
            "delegated_llm_present": False,
            "native_components": {
                "filesystem_and_shell": "deepagents.LocalShellBackend",
                "checkpointing": (
                    "langgraph.SqliteSaver (standalone) or Agent Server Store"
                ),
                "transport": "official MCP Python SDK 2.x",
            },
            "capabilities": list(ABI_TOOL_NAMES),
            "known_limits": [
                "LocalShellBackend is not itself a sandbox",
                "execute is bounded synchronous execution, not a persistent PTY",
                "LangGraph persists tool-plane state but cannot wrap ChatGPT's hidden model loop",
                "ChatGPT host-side MCP catalog freshness remains an external failure plane",
            ],
        }

    def open(self, path: str) -> dict[str, Any]:
        root = self._resolve_allowed_root(path)
        with self._lock:
            existing_id = self._by_root.get(root)
            if existing_id is not None:
                return self._workspaces[existing_id].public_view()

            workspace_id = "ws_" + hashlib.sha256(str(root).encode()).hexdigest()[:12]
            backend = LocalShellBackend(
                root_dir=root,
                virtual_mode=False,
                timeout=self._config.command_timeout_seconds,
                max_output_bytes=self._config.max_output_bytes,
                env=dict(self._config.safe_environment),
                inherit_env=False,
            )
            handle = WorkspaceHandle(
                workspace_id=workspace_id,
                root=root,
                backend=backend,
                opened_at=datetime.now(UTC).isoformat(),
            )
            self._workspaces[workspace_id] = handle
            self._by_root[root] = workspace_id
            return handle.public_view()

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [handle.public_view() for handle in self._workspaces.values()]

    def status(self, workspace_id: str) -> dict[str, Any]:
        return self._get(workspace_id).public_view()

    def ls(self, workspace_id: str, path: str = ".") -> dict[str, Any]:
        handle = self._get(workspace_id)
        return asdict(handle.backend.ls(self._normalize_file_path(handle, path)))

    def read(
        self, workspace_id: str, file_path: str, offset: int = 0, limit: int = 2000
    ) -> dict[str, Any]:
        handle = self._get(workspace_id)
        return asdict(
            handle.backend.read(
                self._normalize_file_path(handle, file_path), offset=offset, limit=limit
            )
        )

    def write(self, workspace_id: str, file_path: str, content: str) -> dict[str, Any]:
        handle = self._get(workspace_id)
        return asdict(
            handle.backend.write(self._normalize_file_path(handle, file_path), content)
        )

    def edit(
        self,
        workspace_id: str,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> dict[str, Any]:
        handle = self._get(workspace_id)
        return asdict(
            handle.backend.edit(
                self._normalize_file_path(handle, file_path),
                old_string,
                new_string,
                replace_all=replace_all,
            )
        )

    def delete(self, workspace_id: str, file_path: str) -> dict[str, Any]:
        handle = self._get(workspace_id)
        return asdict(
            handle.backend.delete(self._normalize_file_path(handle, file_path))
        )

    def glob(
        self, workspace_id: str, pattern: str, path: str | None = None
    ) -> dict[str, Any]:
        handle = self._get(workspace_id)
        normalized_path = (
            self._normalize_file_path(handle, path) if path is not None else None
        )
        return asdict(handle.backend.glob(pattern, normalized_path))

    def grep(
        self,
        workspace_id: str,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
        max_count: int | None = 200,
        context_lines: int = 0,
    ) -> dict[str, Any]:
        handle = self._get(workspace_id)
        normalized_path = (
            self._normalize_file_path(handle, path) if path is not None else None
        )
        return asdict(
            handle.backend.grep(
                pattern,
                normalized_path,
                glob,
                max_count=max_count,
                context_lines=context_lines,
            )
        )

    def execute(
        self, workspace_id: str, command: str, timeout: int | None = None
    ) -> dict[str, Any]:
        handle = self._get(workspace_id)
        return asdict(handle.backend.execute(command, timeout=timeout))

    def _resolve_allowed_root(self, raw_path: str) -> Path:
        candidate = Path(raw_path).expanduser().resolve()
        if not candidate.exists():
            raise BridgeError(f"workspace path does not exist: {candidate}")
        if not candidate.is_dir():
            raise BridgeError(f"workspace path is not a directory: {candidate}")
        if not any(
            _is_relative_to(candidate, root) for root in self._config.allowed_roots
        ):
            allowed = ", ".join(str(root) for root in self._config.allowed_roots)
            raise BridgeError(f"workspace path is outside allowed roots: {allowed}")
        return candidate

    def _get(self, workspace_id: str) -> WorkspaceHandle:
        with self._lock:
            try:
                return self._workspaces[workspace_id]
            except KeyError as exc:
                raise BridgeError(f"unknown workspace_id: {workspace_id}") from exc

    @staticmethod
    def _normalize_file_path(handle: WorkspaceHandle, raw_path: str | None) -> str:
        if raw_path is None or raw_path in {"", ".", "/"}:
            return "."
        path = Path(raw_path)
        if path.is_absolute():
            raise BridgeError(
                "file tools use workspace-relative paths; shell commands also start at "
                "the workspace root"
            )
        resolved = (handle.root / path).resolve()
        if not _is_relative_to(resolved, handle.root):
            raise BridgeError("file path escapes the workspace root")
        return resolved.relative_to(handle.root).as_posix()

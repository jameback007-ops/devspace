from __future__ import annotations

import hashlib
import os
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from threading import RLock
from typing import TYPE_CHECKING, Any

from deepagents.backends import BackendProtocol, LocalShellBackend

from .sandbox_protocol import NativeProcessSession, NativeSandboxAttachment

from .tool_abi import (
    ABI_FINGERPRINT_SHA256,
    ABI_TOOL_NAMES,
    ABI_VERSION,
    PREDECESSOR_ABI_FINGERPRINT_SHA256,
    PREDECESSOR_ABI_VERSION,
)

if TYPE_CHECKING:
    from .workstream import WorkstreamBinding


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
    max_transfer_bytes: int = 4_000_000
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
            max_transfer_bytes=int(
                os.environ.get("BRIDGE_MAX_TRANSFER_BYTES", "4000000")
            ),
            safe_environment=safe_environment,
        )


@dataclass
class WorkspaceHandle:
    workspace_id: str
    root: str
    backend: BackendProtocol
    backend_name: str
    opened_at: str
    local_root: Path | None = None
    sandbox_provider: str | None = None
    sandbox_resource_name: str | None = None
    process_session: NativeProcessSession | None = None
    workstream: WorkstreamBinding | None = None
    identity_key: tuple[str, str] | None = None

    def public_view(self) -> dict[str, Any]:
        return {
            "workspace_id": self.workspace_id,
            "root": self.root,
            "opened_at": self.opened_at,
            "backend": self.backend_name,
            "path_mode": "workspace_relative",
            "shell_boundary": (
                f"{self.sandbox_provider}_sandbox"
                if self.sandbox_provider is not None
                else "container_or_process_boundary"
            ),
            "sandbox_provider": self.sandbox_provider,
            "sandbox_resource_name": self.sandbox_resource_name,
            "persistent_process": self.process_session is not None,
            "workstream": self.workstream.public_view() if self.workstream else None,
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
        self._by_identity: dict[tuple[str, str], str] = {}
        self._lock = RLock()

    @property
    def config(self) -> BridgeConfig:
        return self._config

    def capability_manifest(self) -> dict[str, Any]:
        return {
            "schema_version": "chatgpt-langchain-capability-bridge.v2",
            "tool_abi": {
                "version": ABI_VERSION,
                "fingerprint_sha256": ABI_FINGERPRINT_SHA256,
                "tool_names": list(ABI_TOOL_NAMES),
                "predecessor": {
                    "version": PREDECESSOR_ABI_VERSION,
                    "fingerprint_sha256": PREDECESSOR_ABI_FINGERPRINT_SHA256,
                    "qualification_role": "phase_0_primitive_coding_proof",
                },
                "compatibility_policy": (
                    "v2 is the direct-host qualification ABI; freeze names, action "
                    "enums, required inputs, and descriptor semantics after its final "
                    "fingerprint is sealed"
                ),
            },
            "reasoning_owner": "chatgpt_webchat",
            "delegated_llm_present": False,
            "native_components": {
                "filesystem_and_shell": (
                    "deepagents.LocalShellBackend or a configured native Deep Agents sandbox backend"
                ),
                "checkpointing": (
                    "langgraph.SqliteSaver (standalone) or Agent Server Store"
                ),
                "transport": "official MCP Python SDK 2.x",
            },
            "capabilities": list(ABI_TOOL_NAMES),
            "known_limits": [
                "LocalShellBackend is not itself a sandbox",
                "persistent PTY requires a configured native provider with resumable process handles",
                "LangGraph persists tool-plane state but cannot wrap ChatGPT's hidden model loop",
                "ChatGPT host-side MCP catalog freshness remains an external failure plane",
                "Deep Agents automatic summarization and system-prompt middleware remain agent-loop capabilities, not WebChat middleware",
            ],
        }

    def open(
        self, path: str, *, workstream: WorkstreamBinding | None = None
    ) -> dict[str, Any]:
        root = self._resolve_allowed_root(path)
        workstream_ref = workstream.workstream_ref if workstream else ""
        identity_key = (str(root), workstream_ref)
        with self._lock:
            existing_id = self._by_identity.get(identity_key)
            if existing_id is not None:
                return self._workspaces[existing_id].public_view()

            identity = str(root) if not workstream_ref else f"{root}\0{workstream_ref}"
            workspace_id = "ws_" + hashlib.sha256(identity.encode()).hexdigest()[:12]
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
                root=str(root),
                backend=backend,
                backend_name="deepagents.LocalShellBackend",
                opened_at=datetime.now(UTC).isoformat(),
                local_root=root,
                workstream=workstream,
                identity_key=identity_key,
            )
            self._workspaces[workspace_id] = handle
            self._by_identity[identity_key] = workspace_id
            return handle.public_view()

    def attach_native_sandbox(
        self, attachment: NativeSandboxAttachment
    ) -> dict[str, Any]:
        """Attach one provider-owned native Deep Agents sandbox workspace.

        Provisioning and lifecycle authority stay with the provider adapter. This
        method only projects an already-authorized sandbox through the same
        primitive file/search/edit surface used by local workspaces.
        """

        normalized_root = self._normalize_sandbox_root(attachment.workspace_root)
        identity = f"{attachment.provider}:{attachment.resource_name}:{normalized_root}"
        workspace_id = "ws_sbx_" + hashlib.sha256(identity.encode()).hexdigest()[:12]
        with self._lock:
            existing = self._workspaces.get(workspace_id)
            if existing is not None:
                return existing.public_view()
            handle = WorkspaceHandle(
                workspace_id=workspace_id,
                root=normalized_root,
                backend=attachment.backend,
                backend_name=attachment.backend_name,
                opened_at=datetime.now(UTC).isoformat(),
                sandbox_provider=attachment.provider,
                sandbox_resource_name=attachment.resource_name,
                process_session=attachment.process_session,
                identity_key=(
                    f"sandbox:{attachment.provider}:{attachment.resource_name}",
                    "",
                ),
            )
            self._workspaces[workspace_id] = handle
            return handle.public_view()

    def detach(self, workspace_id: str) -> dict[str, Any]:
        """Detach a workspace handle without deleting its files or sandbox."""

        with self._lock:
            try:
                handle = self._workspaces.pop(workspace_id)
            except KeyError as exc:
                raise BridgeError(f"unknown workspace_id: {workspace_id}") from exc
            if handle.identity_key is not None:
                self._by_identity.pop(handle.identity_key, None)
        return {"workspace_id": workspace_id, "detached": True}

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
        if handle.process_session is not None:
            effective_timeout = timeout or self._config.command_timeout_seconds
            result = handle.process_session.run(
                command,
                timeout=effective_timeout,
                cwd=handle.root,
                wait=True,
            )
            if not hasattr(result, "exit_code"):
                raise BridgeError(
                    "native sandbox returned a non-terminal command handle"
                )
            output = result.stdout or ""
            if result.stderr:
                output += ("\n" if output else "") + result.stderr
            encoded = output.encode("utf-8")
            truncated = len(encoded) > self._config.max_output_bytes
            if truncated:
                output = encoded[: self._config.max_output_bytes].decode(
                    "utf-8", errors="ignore"
                )
            return {
                "output": output,
                "exit_code": int(result.exit_code),
                "truncated": truncated,
            }
        return asdict(handle.backend.execute(command, timeout=timeout))

    def upload_bytes(
        self, workspace_id: str, file_path: str, content: bytes
    ) -> dict[str, Any]:
        if len(content) > self._config.max_transfer_bytes:
            raise BridgeError(
                f"artifact exceeds BRIDGE_MAX_TRANSFER_BYTES={self._config.max_transfer_bytes}"
            )
        handle = self._get(workspace_id)
        path = self._normalize_file_path(handle, file_path)
        responses = handle.backend.upload_files([(path, content)])
        if len(responses) != 1:
            raise BridgeError(
                "native backend returned an invalid upload response count"
            )
        return asdict(responses[0])

    def download_bytes(self, workspace_id: str, file_path: str) -> tuple[bytes, str]:
        handle = self._get(workspace_id)
        path = self._normalize_file_path(handle, file_path)
        responses = handle.backend.download_files([path])
        if len(responses) != 1:
            raise BridgeError(
                "native backend returned an invalid download response count"
            )
        response = responses[0]
        if response.error is not None or response.content is None:
            raise BridgeError(
                f"native artifact download failed: {response.error or 'missing_content'}"
            )
        if len(response.content) > self._config.max_transfer_bytes:
            raise BridgeError(
                f"artifact exceeds BRIDGE_MAX_TRANSFER_BYTES={self._config.max_transfer_bytes}"
            )
        return response.content, response.path

    def get_handle(self, workspace_id: str) -> WorkspaceHandle:
        """Return one exact internal handle for another bounded capability plane."""

        return self._get(workspace_id)

    def workstream_for_agent_thread(
        self, agent_thread_id: str
    ) -> WorkstreamBinding | None:
        with self._lock:
            for handle in self._workspaces.values():
                binding = handle.workstream
                if binding and binding.agent_thread_id == agent_thread_id:
                    return binding
        return None

    def normalize_file_path(self, workspace_id: str, raw_path: str) -> str:
        return self._normalize_file_path(self._get(workspace_id), raw_path)

    def display_backend_path(self, workspace_id: str, backend_path: str) -> str:
        """Convert a backend-native path to the stable workspace-relative form."""

        handle = self._get(workspace_id)
        if handle.local_root is not None:
            local_path = Path(backend_path)
            if not local_path.is_absolute():
                rendered = local_path.as_posix()
                return rendered[2:] if rendered.startswith("./") else rendered
            resolved = local_path.resolve()
            if not _is_relative_to(resolved, handle.local_root):
                raise BridgeError("backend path escapes the local workspace root")
            return resolved.relative_to(handle.local_root).as_posix() or "."

        root = PurePosixPath(handle.root)
        sandbox_path = PurePosixPath(backend_path)
        if not sandbox_path.is_absolute():
            rendered = sandbox_path.as_posix()
            return rendered[2:] if rendered.startswith("./") else rendered
        try:
            return sandbox_path.relative_to(root).as_posix() or "."
        except ValueError as exc:
            raise BridgeError(
                "backend path escapes the sandbox workspace root"
            ) from exc

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
            return "." if handle.local_root is not None else handle.root
        path = Path(raw_path)
        if path.is_absolute():
            raise BridgeError(
                "file tools use workspace-relative paths; shell commands also start at "
                "the workspace root"
            )
        if ".." in path.parts:
            raise BridgeError("file path escapes the workspace root")

        if handle.local_root is not None:
            resolved = (handle.local_root / path).resolve()
            if not _is_relative_to(resolved, handle.local_root):
                raise BridgeError("file path escapes the workspace root")
            return resolved.relative_to(handle.local_root).as_posix()

        relative = PurePosixPath(path.as_posix())
        if relative.is_absolute() or ".." in relative.parts:
            raise BridgeError("file path escapes the sandbox workspace root")
        return (PurePosixPath(handle.root) / relative).as_posix()

    @staticmethod
    def _normalize_sandbox_root(root: str) -> str:
        path = PurePosixPath(root)
        if not path.is_absolute() or ".." in path.parts:
            raise BridgeError(
                "sandbox workspace root must be an absolute contained path"
            )
        normalized = path.as_posix().rstrip("/")
        if not normalized:
            raise BridgeError("sandbox workspace root cannot be filesystem root")
        return normalized

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from deepagents.backends import BackendProtocol


@runtime_checkable
class NativeCommandHandle(Protocol):
    """Provider-neutral subset required for resumable process projection."""

    @property
    def command_id(self) -> str | None: ...

    @property
    def result(self) -> Any: ...

    @property
    def last_stdout_offset(self) -> int: ...

    @property
    def last_stderr_offset(self) -> int: ...

    def __iter__(self) -> Iterator[Any]: ...

    def send_input(self, data: str) -> None: ...

    def kill(self) -> None: ...


@runtime_checkable
class NativeProcessSession(Protocol):
    """Optional sandbox process feature richer than BaseSandbox.execute."""

    @property
    def name(self) -> str: ...

    def run(
        self,
        command: str,
        *,
        timeout: int = 60,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        shell: str = "/bin/bash",
        idle_timeout: int = 300,
        kill_on_disconnect: bool = False,
        ttl_seconds: int = 600,
        pty: bool = False,
        wait: bool = True,
    ) -> Any: ...

    def reconnect(
        self,
        command_id: str,
        *,
        stdout_offset: int = 0,
        stderr_offset: int = 0,
    ) -> NativeCommandHandle: ...


@dataclass(frozen=True)
class NativeSandboxAttachment:
    """One provider-owned sandbox projected through Deep Agents backends."""

    provider: str
    resource_name: str
    backend: BackendProtocol
    backend_name: str
    workspace_root: str
    process_session: NativeProcessSession | None
    metadata: dict[str, Any]


class NativeSandboxProvider(Protocol):
    """Small provider port; MCP schemas remain stable when providers change."""

    @property
    def provider_id(self) -> str: ...

    def manifest(self) -> dict[str, Any]: ...

    def list(self) -> list[dict[str, Any]]: ...

    def create(
        self,
        *,
        resource_name: str,
        snapshot_id: str,
        snapshot_name: str,
        workspace_root: str,
        idle_ttl_seconds: int,
        delete_after_stop_seconds: int,
    ) -> NativeSandboxAttachment: ...

    def attach(
        self,
        *,
        resource_name: str,
        workspace_root: str,
    ) -> NativeSandboxAttachment: ...

    def status(self, resource_name: str) -> dict[str, Any]: ...

    def stop(self, resource_name: str) -> None: ...

    def delete(self, resource_name: str) -> None: ...

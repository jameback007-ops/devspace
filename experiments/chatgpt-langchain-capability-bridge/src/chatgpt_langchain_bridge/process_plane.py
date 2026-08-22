from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from threading import Condition, RLock, Thread
from typing import Any

from .registry import BridgeError, WorkspaceRegistry
from .sandbox_plane import SandboxPlane


@dataclass
class ProcessRecord:
    process_id: str
    workspace_id: str
    command_byte_count: int
    handle: Any
    created_at: str
    pty: bool
    status: str = "running"
    exit_code: int | None = None
    error: str | None = None
    next_sequence: int = 1
    base_sequence: int = 1
    buffered_bytes: int = 0
    events: deque[dict[str, Any]] = field(default_factory=deque)
    lock: RLock = field(default_factory=RLock)
    condition: Condition = field(init=False)

    def __post_init__(self) -> None:
        self.condition = Condition(self.lock)


class ProcessPlane:
    """Bounded MCP projection over one native resumable command handle."""

    def __init__(
        self,
        registry: WorkspaceRegistry,
        sandboxes: SandboxPlane,
        *,
        max_buffer_bytes: int = 1_000_000,
        max_events: int = 4000,
        max_processes: int = 100,
        max_command_bytes: int = 65_536,
        max_input_bytes: int = 65_536,
        max_ttl_seconds: int = 86_400,
        max_idle_timeout_seconds: int = 3_600,
    ) -> None:
        self._registry = registry
        self._sandboxes = sandboxes
        self._max_buffer_bytes = max_buffer_bytes
        self._max_events = max_events
        self._max_processes = max_processes
        self._max_command_bytes = max_command_bytes
        self._max_input_bytes = max_input_bytes
        self._max_ttl_seconds = max_ttl_seconds
        self._max_idle_timeout_seconds = max_idle_timeout_seconds
        self._records: dict[str, ProcessRecord] = {}
        self._lock = RLock()

    def manifest(self) -> dict[str, Any]:
        sandbox_manifest = self._sandboxes.manifest()
        return {
            "state": sandbox_manifest["state"],
            "native_component": "NativeCommandHandle provider port",
            "features": [
                "pty",
                "stdin",
                "kill_process_group",
                "native_command_id",
                "stdout_stderr_offsets",
                "manual_reconnect",
                "sdk_auto_reconnect",
            ],
            "adapter_state": "bounded_output_buffer_and_mcp_poll_projection",
            "restart_resume": "explicit command_id plus native offsets",
            "bounded_long_poll": True,
        }

    def operate(
        self,
        action: str,
        *,
        workspace_id: str = "",
        process_id: str = "",
        command: str = "",
        chars: str = "",
        after_sequence: int = 0,
        limit: int = 100,
        pty: bool = True,
        ttl_seconds: int = 3600,
        idle_timeout_seconds: int = 300,
        stdout_offset: int = 0,
        stderr_offset: int = 0,
        wait_seconds: float = 0,
    ) -> dict[str, Any]:
        if action == "manifest":
            return self.manifest()
        if action == "list":
            with self._lock:
                return {
                    "processes": [
                        self._public(record) for record in self._records.values()
                    ]
                }
        if action == "start":
            if not workspace_id or not command:
                raise BridgeError(
                    "workspace_id and command are required for process start"
                )
            command_bytes = len(command.encode("utf-8"))
            if command_bytes > self._max_command_bytes:
                raise BridgeError(
                    f"command exceeds maximum size of {self._max_command_bytes} bytes"
                )
            self._ensure_capacity()
            session = self._sandboxes.get_process_session(workspace_id)
            root = self._registry.get_handle(workspace_id).root
            handle = session.run(
                command,
                cwd=root,
                wait=False,
                pty=pty,
                kill_on_disconnect=False,
                ttl_seconds=max(60, min(ttl_seconds, self._max_ttl_seconds)),
                idle_timeout=max(
                    30,
                    min(idle_timeout_seconds, self._max_idle_timeout_seconds),
                ),
            )
            native_id = getattr(handle, "command_id", None)
            if not native_id:
                raise BridgeError("native sandbox did not return a command_id")
            return self._register(
                process_id=str(native_id),
                workspace_id=workspace_id,
                command=command,
                handle=handle,
                pty=pty,
            )
        if action == "resume":
            if not workspace_id or not process_id:
                raise BridgeError(
                    "workspace_id and process_id are required for process resume"
                )
            with self._lock:
                existing = self._records.get(process_id)
            if existing is not None:
                return self._public(existing)
            self._ensure_capacity()
            session = self._sandboxes.get_process_session(workspace_id)
            handle = session.reconnect(
                process_id,
                stdout_offset=max(0, stdout_offset),
                stderr_offset=max(0, stderr_offset),
            )
            return self._register(
                process_id=process_id,
                workspace_id=workspace_id,
                command="",
                handle=handle,
                pty=True,
            )

        record = self._get(process_id)
        if action == "poll":
            return self._poll(record, after_sequence, limit, wait_seconds)
        if action == "input":
            input_bytes = len(chars.encode("utf-8"))
            if input_bytes > self._max_input_bytes:
                raise BridgeError(
                    f"process input exceeds maximum size of {self._max_input_bytes} bytes"
                )
            with record.lock:
                if record.status not in {"running", "cancel_requested"}:
                    raise BridgeError("process is not accepting input")
            record.handle.send_input(chars)
            return {**self._public(record), "input_bytes": input_bytes}
        if action == "cancel":
            with record.lock:
                if record.status not in {"running", "cancel_requested"}:
                    return self._public_locked(record)
            record.handle.kill()
            with record.lock:
                if record.status == "running":
                    record.status = "cancel_requested"
                record.condition.notify_all()
            return self._public(record)
        raise BridgeError(
            "process action must be manifest, list, start, resume, poll, input, or cancel"
        )

    def _register(
        self,
        *,
        process_id: str,
        workspace_id: str,
        command: str,
        handle: Any,
        pty: bool,
    ) -> dict[str, Any]:
        record = ProcessRecord(
            process_id=process_id,
            workspace_id=workspace_id,
            command_byte_count=len(command.encode("utf-8")),
            handle=handle,
            created_at=datetime.now(UTC).isoformat(),
            pty=pty,
        )
        with self._lock:
            if process_id in self._records:
                raise BridgeError(f"process_id is already registered: {process_id}")
            self._records[process_id] = record
        Thread(
            target=self._consume,
            args=(record,),
            name=f"bridge-process-{process_id[:12]}",
            daemon=True,
        ).start()
        return self._public(record)

    def _consume(self, record: ProcessRecord) -> None:
        try:
            for chunk in record.handle:
                self._append_event(
                    record,
                    {
                        "stream": chunk.stream,
                        "data": chunk.data,
                        "offset": chunk.offset,
                    },
                )
            result = record.handle.result
            with record.lock:
                record.exit_code = int(result.exit_code)
                record.status = "completed"
                record.condition.notify_all()
        except Exception as exc:  # Native SDK failure must remain observable.
            with record.lock:
                record.status = "failed"
                record.error = type(exc).__name__
                record.condition.notify_all()

    def _append_event(self, record: ProcessRecord, event: dict[str, Any]) -> None:
        data_bytes = len(str(event.get("data", "")).encode("utf-8"))
        with record.lock:
            event = {"sequence": record.next_sequence, **event}
            record.next_sequence += 1
            record.events.append(event)
            record.buffered_bytes += data_bytes
            while record.events and (
                record.buffered_bytes > self._max_buffer_bytes
                or len(record.events) > self._max_events
            ):
                dropped = record.events.popleft()
                record.buffered_bytes -= len(
                    str(dropped.get("data", "")).encode("utf-8")
                )
                record.base_sequence = int(dropped["sequence"]) + 1
            record.condition.notify_all()

    def _poll(
        self,
        record: ProcessRecord,
        after_sequence: int,
        limit: int,
        wait_seconds: float,
    ) -> dict[str, Any]:
        bounded_limit = max(1, min(limit, 500))
        bounded_wait = max(0.0, min(float(wait_seconds), 110.0))
        requested_sequence = max(0, after_sequence)
        with record.lock:
            deadline = time.monotonic() + bounded_wait
            while (
                bounded_wait > 0
                and record.status in {"running", "cancel_requested"}
                and not any(
                    int(event["sequence"]) > requested_sequence
                    for event in record.events
                )
            ):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                record.condition.wait(timeout=remaining)
            events = [
                event
                for event in record.events
                if int(event["sequence"]) > requested_sequence
            ][:bounded_limit]
            return {
                **self._public_locked(record),
                "events": events,
                "events_truncated": len(events) == bounded_limit,
                "requested_after_sequence": requested_sequence,
                "oldest_available_sequence": record.base_sequence,
                "wait_seconds": bounded_wait,
            }

    def _ensure_capacity(self) -> None:
        with self._lock:
            active = sum(
                record.status in {"running", "cancel_requested"}
                for record in self._records.values()
            )
            if active >= self._max_processes:
                raise BridgeError(
                    f"active process limit reached: {self._max_processes}"
                )

    def _get(self, process_id: str) -> ProcessRecord:
        if not process_id:
            raise BridgeError("process_id is required")
        with self._lock:
            try:
                return self._records[process_id]
            except KeyError as exc:
                raise BridgeError(f"unknown process_id: {process_id}") from exc

    def _public(self, record: ProcessRecord) -> dict[str, Any]:
        with record.lock:
            return self._public_locked(record)

    @staticmethod
    def _public_locked(record: ProcessRecord) -> dict[str, Any]:
        return {
            "process_id": record.process_id,
            "workspace_id": record.workspace_id,
            "command_byte_count": record.command_byte_count,
            "created_at": record.created_at,
            "pty": record.pty,
            "status": record.status,
            "exit_code": record.exit_code,
            "error": record.error,
            "last_sequence": record.next_sequence - 1,
            "last_stdout_offset": int(getattr(record.handle, "last_stdout_offset", 0)),
            "last_stderr_offset": int(getattr(record.handle, "last_stderr_offset", 0)),
        }

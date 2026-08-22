from __future__ import annotations

import hashlib
import inspect
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal

from langgraph_sdk import get_sync_client

from .registry import BridgeError, WorkspaceRegistry
from .serialization import json_safe


DurabilityMode = Literal["direct", "async", "sync", "exit"]


@dataclass(frozen=True)
class OperationDurability:
    operation_class: str
    execution_path: str
    durability: DurabilityMode
    on_disconnect: str
    idempotency_policy: str
    mcp_tasks_preferred: bool


class NativeDurabilityPolicy:
    """Risk policy over native LangGraph/Agent Server execution semantics.

    This is routing policy, not a checkpoint or workflow engine. Reads remain
    direct. File mutations on managed worktrees use a native Agent Server run
    with synchronous checkpoint durability. Arbitrary shell and external
    effects are not guessed from command text; they require a future explicit
    operation class so the bridge cannot accidentally auto-retry an effect.
    """

    _READ_TOOLS = {
        "capability_manifest",
        "workspace_status",
        "workspace_list",
        "ls",
        "read_file",
        "glob",
        "grep",
        "checkpoint_read",
        "context_discover",
        "context_read",
        "observability_status",
    }
    _MATERIAL_FILE_TOOLS = {"write_file", "edit_file", "delete_file"}

    def classify(
        self, tool_name: str, *, managed_worktree: bool
    ) -> OperationDurability:
        if tool_name in self._READ_TOOLS:
            return OperationDurability(
                operation_class="read",
                execution_path="direct_native_backend",
                durability="direct",
                on_disconnect="request_scoped",
                idempotency_policy="not_required",
                mcp_tasks_preferred=False,
            )
        if tool_name in self._MATERIAL_FILE_TOOLS and managed_worktree:
            return OperationDurability(
                operation_class="idempotent_file_mutation",
                execution_path="agent_server_functional_api_run",
                durability="sync",
                on_disconnect="continue",
                idempotency_policy="before_after_digest_compare",
                mcp_tasks_preferred=False,
            )
        if tool_name == "execute":
            return OperationDurability(
                operation_class="unclassified_shell",
                execution_path="direct_until_explicit_operation_class_exists",
                durability="direct",
                on_disconnect="request_scoped",
                idempotency_policy="never_infer_from_raw_command",
                mcp_tasks_preferred=True,
            )
        return OperationDurability(
            operation_class="native_runtime_or_explicit_control",
            execution_path="existing_native_capability_plane",
            durability="direct",
            on_disconnect="native_capability_specific",
            idempotency_policy="native_or_explicit",
            mcp_tasks_preferred=False,
        )


@dataclass(frozen=True)
class DurableMaterialConfig:
    enabled: bool = False
    agent_server_url: str | None = None
    assistant_id: str = "bridge_material_operation"
    request_timeout_seconds: float = 60.0

    @classmethod
    def from_environment(cls) -> DurableMaterialConfig:
        enabled = os.environ.get(
            "BRIDGE_DURABLE_MATERIAL_OPERATIONS", "false"
        ).strip().casefold() in {"1", "true", "yes", "on"}
        agent_server_url = os.environ.get("BRIDGE_AGENT_SERVER_URL", "").strip()
        if not agent_server_url and os.environ.get(
            "BRIDGE_AGENT_SERVER_SELF", ""
        ).strip().casefold() in {"1", "true", "yes", "on"}:
            agent_server_url = f"http://127.0.0.1:{os.environ.get('PORT', '8000')}"
        return cls(
            enabled=enabled,
            agent_server_url=agent_server_url or None,
            assistant_id=os.environ.get(
                "BRIDGE_MATERIAL_OPERATION_ASSISTANT_ID",
                "bridge_material_operation",
            ),
            request_timeout_seconds=max(
                1.0,
                min(
                    float(
                        os.environ.get(
                            "BRIDGE_AGENT_SERVER_REQUEST_TIMEOUT_SECONDS", "60"
                        )
                    ),
                    120.0,
                ),
            ),
        )


class DurableMaterialExecutor:
    """Project idempotent file mutations into one native Agent Server run."""

    def __init__(
        self,
        registry: WorkspaceRegistry,
        config: DurableMaterialConfig | None = None,
        policy: NativeDurabilityPolicy | None = None,
        client_factory: Callable[..., Any] = get_sync_client,
    ) -> None:
        self._registry = registry
        self._config = config or DurableMaterialConfig.from_environment()
        self._policy = policy or NativeDurabilityPolicy()
        self._client_factory = client_factory
        self._client_instance: Any | None = None

    def manifest(self) -> dict[str, Any]:
        return {
            "state": (
                "available"
                if self._config.enabled and self._config.agent_server_url
                else "disabled"
            ),
            "native_components": [
                "langgraph.func.entrypoint",
                "langgraph.func.task",
                "langgraph_sdk.runs",
                "agent_server_checkpointer_and_queue",
            ],
            "material_assistant_id": self._config.assistant_id,
            "managed_file_mutation_durability": "sync",
            "disconnect_policy": "continue",
            "idempotency": "before_after_digest_compare",
            "mcp_tasks_extension": "capability_detect_then_map_task_id_to_run_id",
            "raw_shell_auto_classification": False,
            "external_effect_policy": "intent_receipt_reconcile_no_blind_retry",
        }

    def write_file(
        self, workspace_id: str, file_path: str, content: str
    ) -> dict[str, Any]:
        handle = self._registry.get_handle(workspace_id)
        if not self._should_use_durable_run(handle):
            return self._registry.write(workspace_id, file_path, content)
        relative, before = self._read_current(workspace_id, file_path)
        after = content.encode("utf-8")
        return self._run(
            handle,
            operation="write",
            file_path=relative,
            before=before,
            after=after,
            content=content,
        )

    def edit_file(
        self,
        workspace_id: str,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool,
    ) -> dict[str, Any]:
        handle = self._registry.get_handle(workspace_id)
        if not self._should_use_durable_run(handle):
            return self._registry.edit(
                workspace_id,
                file_path,
                old_string,
                new_string,
                replace_all,
            )
        relative, before = self._read_current(workspace_id, file_path)
        if before is None:
            raise BridgeError("cannot edit a missing file")
        text = before.decode("utf-8")
        occurrences = text.count(old_string)
        if occurrences == 0:
            raise BridgeError("old_string was not found in the target file")
        if not replace_all and occurrences != 1:
            raise BridgeError(
                "old_string is not unique; set replace_all=true or provide more context"
            )
        updated = (
            text.replace(old_string, new_string)
            if replace_all
            else text.replace(old_string, new_string, 1)
        )
        return self._run(
            handle,
            operation="edit",
            file_path=relative,
            before=before,
            after=updated.encode("utf-8"),
            old_string=old_string,
            new_string=new_string,
            replace_all=replace_all,
        )

    def delete_file(self, workspace_id: str, file_path: str) -> dict[str, Any]:
        handle = self._registry.get_handle(workspace_id)
        if not self._should_use_durable_run(handle):
            return self._registry.delete(workspace_id, file_path)
        relative, before = self._read_current(workspace_id, file_path)
        if before is None:
            return {
                "path": relative,
                "error": None,
                "durable_status": "already_applied",
            }
        return self._run(
            handle,
            operation="delete",
            file_path=relative,
            before=before,
            after=None,
        )

    def _should_use_durable_run(self, handle: Any) -> bool:
        decision = self._policy.classify(
            "write_file", managed_worktree=handle.worktree_binding is not None
        )
        return (
            decision.execution_path == "agent_server_functional_api_run"
            and self._config.enabled
            and bool(self._config.agent_server_url)
        )

    def _read_current(
        self, workspace_id: str, file_path: str
    ) -> tuple[str, bytes | None]:
        relative = self._registry.normalize_file_path(workspace_id, file_path)
        handle = self._registry.get_handle(workspace_id)
        target = Path(handle.root, relative).resolve()
        root = Path(handle.root).resolve()
        try:
            target.relative_to(root)
        except ValueError as exc:
            raise BridgeError("material operation path escapes workspace root") from exc
        if not target.exists():
            return relative, None
        if not target.is_file():
            raise BridgeError("material operation target is not a regular file")
        return relative, target.read_bytes()

    def _run(
        self,
        handle: Any,
        *,
        operation: str,
        file_path: str,
        before: bytes | None,
        after: bytes | None,
        **operation_fields: Any,
    ) -> dict[str, Any]:
        binding = handle.worktree_binding
        workstream = handle.workstream
        if binding is None or workstream is None or not workstream.agent_thread_id:
            raise BridgeError(
                "durable material operation requires a managed worktree and Agent Server thread"
            )
        payload = {
            "schema_version": "chatgpt-langchain-material-operation.v1",
            "operation": operation,
            "operation_id": self._operation_id(
                binding.repository_alias,
                workstream.workstream_ref,
                operation,
                file_path,
                before,
                after,
            ),
            "repository_alias": binding.repository_alias,
            "workstream_ref": workstream.workstream_ref,
            "file_path": file_path,
            "before_sha256": self._digest(before),
            "after_sha256": self._digest(after),
            **operation_fields,
        }
        client = self._client()
        create_kwargs = {
            "input": payload,
            "stream_mode": "values",
            "stream_resumable": True,
            "durability": "sync",
            "on_disconnect": "continue",
            "metadata": {
                "bridge_operation_id": payload["operation_id"],
                "bridge_workstream_ref": workstream.workstream_ref,
                "bridge_repository_alias": binding.repository_alias,
            },
        }
        run = client.runs.create(
            workstream.agent_thread_id,
            self._config.assistant_id,
            **self._supported_kwargs(client.runs.create, create_kwargs),
        )
        run_id = self._field(run, "run_id")
        if not run_id:
            raise BridgeError("Agent Server did not return a durable run_id")
        result = client.runs.join(workstream.agent_thread_id, str(run_id))
        safe = json_safe(result)
        if not isinstance(safe, dict):
            raise BridgeError("durable material run returned an invalid result")
        if safe.get("error"):
            raise BridgeError(str(safe["error"])[:500])
        return safe

    def _client(self) -> Any:
        if self._client_instance is None:
            if not self._config.agent_server_url:
                raise BridgeError("Agent Server URL is not configured")
            self._client_instance = self._client_factory(
                url=self._config.agent_server_url,
                timeout=self._config.request_timeout_seconds,
            )
        return self._client_instance

    @staticmethod
    def _supported_kwargs(callable_obj: Any, values: dict[str, Any]) -> dict[str, Any]:
        signature = inspect.signature(callable_obj)
        if any(
            parameter.kind is inspect.Parameter.VAR_KEYWORD
            for parameter in signature.parameters.values()
        ):
            return values
        return {
            key: value for key, value in values.items() if key in signature.parameters
        }

    @staticmethod
    def _field(value: Any, name: str) -> Any:
        if isinstance(value, dict):
            return value.get(name)
        return getattr(value, name, None)

    @staticmethod
    def _digest(value: bytes | None) -> str | None:
        return hashlib.sha256(value).hexdigest() if value is not None else None

    @classmethod
    def _operation_id(
        cls,
        repository_alias: str,
        workstream_ref: str,
        operation: str,
        file_path: str,
        before: bytes | None,
        after: bytes | None,
    ) -> str:
        material = "\0".join(
            [
                repository_alias,
                workstream_ref,
                operation,
                file_path,
                cls._digest(before) or "missing",
                cls._digest(after) or "missing",
            ]
        )
        return hashlib.sha256(material.encode()).hexdigest()

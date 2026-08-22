from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from deepagents.backends import LangSmithSandbox
from langsmith.sandbox import Sandbox, SandboxClient

from .registry import BridgeError, WorkspaceRegistry
from .sandbox_protocol import (
    NativeProcessSession,
    NativeSandboxAttachment,
    NativeSandboxProvider,
)
from .serialization import json_safe


@dataclass(frozen=True)
class SandboxPlaneConfig:
    """Select one native sandbox provider without changing the MCP ABI."""

    provider_id: str | None = None
    default_workspace_root: str = "/workspace"
    max_idle_ttl_seconds: int = 86_400
    max_delete_after_stop_seconds: int = 604_800

    @classmethod
    def from_environment(cls) -> SandboxPlaneConfig:
        return cls(
            provider_id=os.environ.get("BRIDGE_SANDBOX_PROVIDER", "").strip() or None,
            default_workspace_root=os.environ.get(
                "BRIDGE_SANDBOX_WORKSPACE_ROOT", "/workspace"
            ),
            max_idle_ttl_seconds=int(
                os.environ.get("BRIDGE_SANDBOX_MAX_IDLE_TTL_SECONDS", "86400")
            ),
            max_delete_after_stop_seconds=int(
                os.environ.get("BRIDGE_SANDBOX_MAX_DELETE_AFTER_STOP_SECONDS", "604800")
            ),
        )


@dataclass(frozen=True)
class LangSmithProviderConfig:
    name_prefix: str = "zes-chatgpt-bridge-"
    allowed_snapshot_ids: tuple[str, ...] = ()
    allowed_snapshot_names: tuple[str, ...] = ()

    @classmethod
    def from_environment(cls) -> LangSmithProviderConfig:
        def split(name: str) -> tuple[str, ...]:
            raw = os.environ.get(name, "")
            return tuple(item.strip() for item in raw.split(",") if item.strip())

        return cls(
            name_prefix=os.environ.get(
                "BRIDGE_SANDBOX_NAME_PREFIX", "zes-chatgpt-bridge-"
            ),
            allowed_snapshot_ids=split("BRIDGE_SANDBOX_SNAPSHOT_IDS"),
            allowed_snapshot_names=split("BRIDGE_SANDBOX_SNAPSHOT_NAMES"),
        )


class LangSmithSandboxProvider:
    """Native Deep Agents adapter for LangSmith Sandbox.

    The organization entitlement is an external gate. A bound key proves only
    credential presence, so the manifest deliberately reports
    ``configured_unverified`` until a separate live qualification succeeds.
    """

    provider_id = "langsmith"

    def __init__(
        self,
        config: LangSmithProviderConfig | None = None,
        client_factory: Callable[[], SandboxClient] = SandboxClient,
    ) -> None:
        self._config = config or LangSmithProviderConfig.from_environment()
        self._client_factory = client_factory
        self._client_instance: SandboxClient | None = None

    def manifest(self) -> dict[str, Any]:
        key_present = bool(os.environ.get("LANGSMITH_API_KEY"))
        return {
            "provider_id": self.provider_id,
            "state": "configured_unverified" if key_present else "credential_missing",
            "native_components": [
                "langsmith.sandbox.SandboxClient",
                "deepagents.LangSmithSandbox",
            ],
            "credential_present": key_present,
            "endpoint": os.environ.get("LANGSMITH_ENDPOINT"),
            "name_prefix": self._config.name_prefix,
            "snapshot_allowlist_configured": bool(
                self._config.allowed_snapshot_ids or self._config.allowed_snapshot_names
            ),
            "base_sandbox_execute": True,
            "persistent_pty": True,
            "resumable_command_id": True,
            "entitlement_claimed": False,
        }

    def list(self) -> list[dict[str, Any]]:
        self._require_credential()
        return [
            self._sandbox_view(sandbox)
            for sandbox in self._client().list_sandboxes()
            if self._owned_name(sandbox.name)
        ]

    def create(
        self,
        *,
        resource_name: str,
        snapshot_id: str,
        snapshot_name: str,
        workspace_root: str,
        idle_ttl_seconds: int,
        delete_after_stop_seconds: int,
    ) -> NativeSandboxAttachment:
        self._require_credential()
        self._validate_snapshot(snapshot_id, snapshot_name)
        name = resource_name or (self._config.name_prefix + uuid.uuid4().hex[:12])
        self._validate_name(name)
        sandbox = self._client().create_sandbox(
            snapshot_id or None,
            snapshot_name=snapshot_name or None,
            name=name,
            wait_for_ready=True,
            idle_ttl_seconds=max(60, idle_ttl_seconds),
            delete_after_stop_seconds=max(60, delete_after_stop_seconds),
        )
        return self._attachment(sandbox, workspace_root)

    def attach(
        self,
        *,
        resource_name: str,
        workspace_root: str,
    ) -> NativeSandboxAttachment:
        self._require_credential()
        self._validate_name(resource_name)
        return self._attachment(
            self._client().get_sandbox(resource_name), workspace_root
        )

    def status(self, resource_name: str) -> dict[str, Any]:
        self._require_credential()
        self._validate_name(resource_name)
        return json_safe(self._client().get_sandbox_status(resource_name))

    def stop(self, resource_name: str) -> None:
        self._require_credential()
        self._validate_name(resource_name)
        self._client().stop_sandbox(resource_name)

    def delete(self, resource_name: str) -> None:
        self._require_credential()
        self._validate_name(resource_name)
        self._client().delete_sandbox(resource_name)

    def _attachment(
        self, sandbox: Sandbox, workspace_root: str
    ) -> NativeSandboxAttachment:
        return NativeSandboxAttachment(
            provider=self.provider_id,
            resource_name=sandbox.name,
            backend=LangSmithSandbox(sandbox),
            backend_name="deepagents.LangSmithSandbox",
            workspace_root=workspace_root,
            process_session=sandbox,
            metadata=self._sandbox_view(sandbox),
        )

    def _client(self) -> SandboxClient:
        if self._client_instance is None:
            try:
                self._client_instance = self._client_factory()
            except Exception as exc:
                raise BridgeError(
                    f"LangSmith Sandbox client initialization failed: {type(exc).__name__}"
                ) from exc
        return self._client_instance

    @staticmethod
    def _require_credential() -> None:
        if not os.environ.get("LANGSMITH_API_KEY"):
            raise BridgeError("LangSmith sandbox credential is not bound")

    def _validate_snapshot(self, snapshot_id: str, snapshot_name: str) -> None:
        if bool(snapshot_id) == bool(snapshot_name):
            raise BridgeError("provide exactly one of snapshot_id or snapshot_name")
        if snapshot_id and snapshot_id not in self._config.allowed_snapshot_ids:
            raise BridgeError("snapshot_id is outside the configured allowlist")
        if snapshot_name and snapshot_name not in self._config.allowed_snapshot_names:
            raise BridgeError("snapshot_name is outside the configured allowlist")

    def _validate_name(self, name: str) -> None:
        if not name:
            raise BridgeError("sandbox_name is required")
        if not self._owned_name(name):
            raise BridgeError(
                f"sandbox_name must start with configured prefix {self._config.name_prefix!r}"
            )

    def _owned_name(self, name: str) -> bool:
        return bool(name) and name.startswith(self._config.name_prefix)

    @staticmethod
    def _sandbox_view(sandbox: Sandbox) -> dict[str, Any]:
        safe_fields = (
            "name",
            "id",
            "status",
            "status_message",
            "created_at",
            "updated_at",
            "idle_ttl_seconds",
            "delete_after_stop_seconds",
            "stopped_at",
            "snapshot_id",
            "vcpus",
            "mem_bytes",
            "fs_capacity_bytes",
        )
        return {
            field: json_safe(getattr(sandbox, field, None)) for field in safe_fields
        }


class SandboxPlane:
    """Provider-neutral lifecycle plane over native Deep Agents sandboxes."""

    def __init__(
        self,
        registry: WorkspaceRegistry,
        config: SandboxPlaneConfig | None = None,
        providers: dict[str, NativeSandboxProvider] | None = None,
    ) -> None:
        self._registry = registry
        self._config = config or SandboxPlaneConfig.from_environment()
        self._providers = providers or {
            "langsmith": LangSmithSandboxProvider(),
        }

    def manifest(self) -> dict[str, Any]:
        selected = self._config.provider_id
        provider_manifest = (
            self._providers[selected].manifest()
            if selected in self._providers
            else None
        )
        return {
            "state": (
                provider_manifest["state"]
                if provider_manifest is not None
                else "provider_not_configured"
            ),
            "selected_provider": selected,
            "registered_providers": {
                provider_id: provider.manifest()
                for provider_id, provider in sorted(self._providers.items())
            },
            "provider_port": "NativeSandboxProvider",
            "stable_mcp_provider_independent": True,
            "default_workspace_root": self._config.default_workspace_root,
        }

    def operate(
        self,
        action: str,
        *,
        sandbox_name: str = "",
        snapshot_id: str = "",
        snapshot_name: str = "",
        workspace_root: str = "",
        workspace_id: str = "",
        idle_ttl_seconds: int = 900,
        delete_after_stop_seconds: int = 3600,
    ) -> dict[str, Any]:
        if action == "manifest":
            return self.manifest()
        provider = self._provider()
        root = workspace_root or self._config.default_workspace_root

        if action == "list":
            return {
                "provider": provider.provider_id,
                "sandboxes": provider.list(),
            }
        if action == "create":
            attachment = provider.create(
                resource_name=sandbox_name,
                snapshot_id=snapshot_id,
                snapshot_name=snapshot_name,
                workspace_root=root,
                idle_ttl_seconds=max(
                    60,
                    min(idle_ttl_seconds, self._config.max_idle_ttl_seconds),
                ),
                delete_after_stop_seconds=max(
                    60,
                    min(
                        delete_after_stop_seconds,
                        self._config.max_delete_after_stop_seconds,
                    ),
                ),
            )
            return {
                "provider": provider.provider_id,
                "sandbox": attachment.metadata,
                "workspace": self._registry.attach_native_sandbox(attachment),
                "created": True,
            }
        if action == "attach":
            attachment = provider.attach(
                resource_name=sandbox_name,
                workspace_root=root,
            )
            return {
                "provider": provider.provider_id,
                "sandbox": attachment.metadata,
                "workspace": self._registry.attach_native_sandbox(attachment),
                "created": False,
            }
        if action == "status":
            return {
                "provider": provider.provider_id,
                "sandbox_name": sandbox_name,
                "status": provider.status(sandbox_name),
            }
        if action == "detach":
            if not workspace_id:
                raise BridgeError("workspace_id is required for sandbox detach")
            handle = self._registry.get_handle(workspace_id)
            if handle.sandbox_provider is None:
                raise BridgeError("workspace is not backed by a native sandbox")
            return self._registry.detach(workspace_id)
        if action == "stop":
            provider.stop(sandbox_name)
            return {
                "provider": provider.provider_id,
                "sandbox_name": sandbox_name,
                "stopped": True,
            }
        if action == "delete":
            provider.delete(sandbox_name)
            return {
                "provider": provider.provider_id,
                "sandbox_name": sandbox_name,
                "deleted": True,
            }
        raise BridgeError(
            "sandbox action must be manifest, list, create, attach, status, detach, stop, or delete"
        )

    def get_process_session(self, workspace_id: str) -> NativeProcessSession:
        handle = self._registry.get_handle(workspace_id)
        if handle.process_session is None:
            raise BridgeError(
                "persistent process control requires a native sandbox provider with resumable process handles"
            )
        return handle.process_session

    def _provider(self) -> NativeSandboxProvider:
        provider_id = self._config.provider_id
        if not provider_id:
            raise BridgeError("native sandbox provider is not configured")
        try:
            return self._providers[provider_id]
        except KeyError as exc:
            registered = ", ".join(sorted(self._providers)) or "none"
            raise BridgeError(
                f"unknown native sandbox provider {provider_id!r}; registered: {registered}"
            ) from exc

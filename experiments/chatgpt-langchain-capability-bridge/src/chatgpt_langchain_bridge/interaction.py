from __future__ import annotations

import asyncio
import json
import os
import re
from collections import deque
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Protocol
from urllib.parse import urlparse

import httpx
from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
from a2a.helpers.proto_helpers import (
    new_data_part,
    new_message,
    new_text_part,
)
from a2a.types import (
    CancelTaskRequest,
    AgentCard,
    GetTaskRequest,
    Role,
    SendMessageRequest,
)
from google.protobuf.json_format import MessageToDict, ParseDict
from langsmith import uuid7
from a2a.utils.constants import PROTOCOL_VERSION_0_3, TransportProtocol

from .agent_server_plane import AgentServerPlane
from .registry import BridgeError, WorkspaceRegistry
from .workstream import WorkstreamBinding


_REF_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")


class InteractionKind(StrEnum):
    MESSAGE = "message"
    REQUEST = "request"
    RESPONSE = "response"
    TASK = "task"
    STATUS = "status"
    ARTIFACT = "artifact"
    RECEIPT = "receipt"


class InteractionDirection(StrEnum):
    INBOUND = "inbound"
    OUTBOUND = "outbound"


class DeliveryState(StrEnum):
    UNSEEN = "unseen"
    SEEN = "seen"
    ACKNOWLEDGED = "acknowledged"


def _require_ref(value: str, field_name: str) -> str:
    clean = value.strip()
    if not _REF_PATTERN.fullmatch(clean):
        raise BridgeError(
            f"{field_name} must match [A-Za-z0-9][A-Za-z0-9._:/-]{{0,255}}"
        )
    return clean


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(frozen=True)
class EndpointDescriptor:
    """Provider-neutral participant endpoint advertised to the interaction core."""

    endpoint_ref: str
    participant_ref: str
    transport: str = "a2a"
    capability_refs: tuple[str, ...] = ()
    adapter_config: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_ref(self.endpoint_ref, "endpoint_ref")
        _require_ref(self.participant_ref, "participant_ref")
        _require_ref(self.transport, "transport")
        for capability_ref in self.capability_refs:
            _require_ref(capability_ref, "capability_ref")
        if not isinstance(self.adapter_config, dict):
            raise BridgeError("endpoint adapter_config must be an object")

    def public_view(self) -> dict[str, Any]:
        return {
            "endpoint_ref": self.endpoint_ref,
            "participant_ref": self.participant_ref,
            "transport": self.transport,
            "capability_refs": list(self.capability_refs),
            "configured": True,
        }


@dataclass(frozen=True)
class A2AEndpointSettings:
    """A2A-specific configuration kept at the transport adapter edge."""

    base_url: str
    agent_card_path: str = "/.well-known/agent-card.json"
    protocol_mode: str = "strict-v1"

    @classmethod
    def from_endpoint(cls, endpoint: EndpointDescriptor) -> A2AEndpointSettings:
        if endpoint.transport != "a2a":
            raise BridgeError("endpoint is not assigned to the A2A adapter")
        settings = cls(
            base_url=str(endpoint.adapter_config.get("base_url") or ""),
            agent_card_path=str(
                endpoint.adapter_config.get("agent_card_path")
                or "/.well-known/agent-card.json"
            ),
            protocol_mode=str(
                endpoint.adapter_config.get("protocol_mode") or "strict-v1"
            ),
        )
        parsed = urlparse(settings.base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise BridgeError("A2A base_url must be an absolute HTTP(S) URL")
        if parsed.username or parsed.password:
            raise BridgeError("A2A endpoint URLs must not contain credentials")
        if not settings.agent_card_path.startswith("/"):
            raise BridgeError("A2A agent_card_path must be absolute")
        if settings.protocol_mode not in {"strict-v1", "legacy-v0.3"}:
            raise BridgeError("A2A protocol_mode must be strict-v1 or legacy-v0.3")
        return settings


class InteractionAdapter(Protocol):
    """Replaceable transport/runtime adapter under the neutral core."""

    adapter_id: str
    protocol_label: str

    async def discover(self, endpoint: EndpointDescriptor) -> dict[str, Any]: ...

    async def send(
        self,
        endpoint: EndpointDescriptor,
        *,
        text: str,
        data: dict[str, Any] | None,
        context_ref: str,
        task_id: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]: ...

    async def get_task(
        self, endpoint: EndpointDescriptor, task_id: str
    ) -> dict[str, Any]: ...

    async def cancel_task(
        self, endpoint: EndpointDescriptor, task_id: str
    ) -> dict[str, Any]: ...


class EndpointRegistry:
    """Allowlisted A2A endpoints; arbitrary model-supplied URLs are forbidden."""

    def __init__(self, endpoints: dict[str, EndpointDescriptor] | None = None) -> None:
        self._endpoints = (
            endpoints if endpoints is not None else self._from_environment()
        )

    @staticmethod
    def _from_environment() -> dict[str, EndpointDescriptor]:
        import os

        raw = os.environ.get("BRIDGE_A2A_ENDPOINTS", "{}").strip()
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise BridgeError("BRIDGE_A2A_ENDPOINTS must be valid JSON") from exc
        if not isinstance(parsed, dict):
            raise BridgeError("BRIDGE_A2A_ENDPOINTS must be a JSON object")
        endpoints: dict[str, EndpointDescriptor] = {}
        for endpoint_ref, value in parsed.items():
            if not isinstance(endpoint_ref, str) or not isinstance(value, dict):
                raise BridgeError("every A2A endpoint entry must be an object")
            capabilities = value.get("capability_refs", [])
            if not isinstance(capabilities, list) or not all(
                isinstance(item, str) for item in capabilities
            ):
                raise BridgeError("A2A capability_refs must be a list of strings")
            endpoints[endpoint_ref] = EndpointDescriptor(
                endpoint_ref=endpoint_ref,
                participant_ref=str(value.get("participant_ref") or endpoint_ref),
                transport=str(value.get("transport") or "a2a"),
                capability_refs=tuple(capabilities),
                adapter_config=(
                    dict(value["adapter_config"])
                    if isinstance(value.get("adapter_config"), dict)
                    else {
                        "base_url": value.get("base_url"),
                        "agent_card_path": value.get("agent_card_path"),
                        "protocol_mode": value.get("protocol_mode"),
                    }
                ),
            )
        return endpoints

    def get(self, endpoint_ref: str) -> EndpointDescriptor:
        try:
            return self._endpoints[_require_ref(endpoint_ref, "endpoint_ref")]
        except KeyError as exc:
            raise BridgeError(
                "endpoint_ref is not in the configured A2A allowlist"
            ) from exc

    def public_view(self) -> list[dict[str, Any]]:
        return [
            endpoint.public_view()
            for endpoint in sorted(
                self._endpoints.values(), key=lambda item: item.endpoint_ref
            )
        ]


@dataclass(frozen=True)
class InteractionProjection:
    interaction_ref: str
    scope_ref: str
    workstream_ref: str
    direction: str
    kind: str
    native_protocol: str
    native_endpoint_ref: str
    peer_ref: str
    observed_state: str
    observed_at: str
    delivery_state: str = DeliveryState.UNSEEN
    context_ref: str | None = None
    correlation_ref: str | None = None
    native_context_id: str | None = None
    native_task_id: str | None = None
    native_message_id: str | None = None
    agent_server_thread_id: str | None = None
    run_id: str | None = None
    artifact_refs: tuple[str, ...] = ()
    authority_refs: tuple[str, ...] = ()
    trace_context: dict[str, str] = field(default_factory=dict)
    summary: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for field_name in (
            "interaction_ref",
            "scope_ref",
            "workstream_ref",
            "native_endpoint_ref",
            "peer_ref",
        ):
            _require_ref(str(getattr(self, field_name)), field_name)
        if self.context_ref:
            _require_ref(self.context_ref, "context_ref")
        if self.correlation_ref:
            _require_ref(self.correlation_ref, "correlation_ref")
        try:
            InteractionDirection(self.direction)
            InteractionKind(self.kind)
            DeliveryState(self.delivery_state)
        except ValueError as exc:
            raise BridgeError(
                "interaction projection contains an invalid enum value"
            ) from exc
        for artifact_ref in self.artifact_refs:
            _require_ref(artifact_ref, "artifact_ref")
        for authority_ref in self.authority_refs:
            _require_ref(authority_ref, "authority_ref")
        for key, value in self.trace_context.items():
            if key not in {"traceparent", "tracestate", "baggage"}:
                raise BridgeError("trace_context contains an unsupported key")
            if not isinstance(value, str) or len(value) > 4096:
                raise BridgeError("trace_context values must be bounded strings")
        if len(self.summary or "") > 1000:
            raise BridgeError("interaction summary exceeds 1000 characters")

    def public_view(self) -> dict[str, Any]:
        value = asdict(self)
        value["artifact_refs"] = list(self.artifact_refs)
        value["authority_refs"] = list(self.authority_refs)
        value["authority"] = {
            "communication_only": True,
            "creates_task_or_workspace_authority": False,
            "native_task_state_remains_at_protocol_or_runtime_owner": True,
            "delivery_state_owned_by_webchat_edge_adapter": True,
        }
        return value


class ProjectionBackend(Protocol):
    def put(self, scope_ref: str, projection: InteractionProjection) -> None: ...

    def list(self, scope_ref: str, limit: int) -> list[InteractionProjection]: ...

    def get(self, scope_ref: str, interaction_ref: str) -> InteractionProjection: ...


class AgentServerProjectionBackend:
    """Store only WebChat delivery projections in native Agent Server Store."""

    def __init__(self, agent_server: AgentServerPlane) -> None:
        self._agent_server = agent_server

    @staticmethod
    def _namespace(scope_ref: str) -> list[str]:
        return ["interaction-projection", _require_ref(scope_ref, "scope_ref")]

    def put(self, scope_ref: str, projection: InteractionProjection) -> None:
        self._agent_server.store(
            "put",
            namespace=self._namespace(scope_ref),
            key=projection.interaction_ref,
            value=projection.public_view(),
        )

    def list(self, scope_ref: str, limit: int) -> list[InteractionProjection]:
        result = self._agent_server.store(
            "search",
            namespace=self._namespace(scope_ref),
            limit=max(1, min(limit, 100)),
        )
        items = result.get("items", []) if isinstance(result, dict) else []
        projections = []
        for item in items:
            value = item.get("value", item) if isinstance(item, dict) else None
            if isinstance(value, dict) and "interaction_ref" in value:
                projections.append(_projection_from_dict(value))
        return sorted(projections, key=lambda item: item.observed_at, reverse=True)

    def get(self, scope_ref: str, interaction_ref: str) -> InteractionProjection:
        result = self._agent_server.store(
            "get",
            namespace=self._namespace(scope_ref),
            key=_require_ref(interaction_ref, "interaction_ref"),
        )
        value = result.get("value", result) if isinstance(result, dict) else None
        if not isinstance(value, dict) or "interaction_ref" not in value:
            raise BridgeError("interaction projection was not found")
        return _projection_from_dict(value)


def _projection_from_dict(value: dict[str, Any]) -> InteractionProjection:
    allowed = {
        field_name: value[field_name]
        for field_name in InteractionProjection.__dataclass_fields__
        if field_name in value
    }
    for tuple_field in ("artifact_refs", "authority_refs"):
        if tuple_field in allowed:
            allowed[tuple_field] = tuple(allowed[tuple_field])
    return InteractionProjection(**allowed)


class NativeA2AClient:
    """Official A2A SDK adapter; no custom wire protocol is implemented."""

    adapter_id = "a2a"
    protocol_label = "a2a/1.0"

    def __init__(
        self,
        *,
        max_retained_events: int = 50,
        max_event_bytes: int = 200_000,
    ) -> None:
        self._max_retained_events = max(1, max_retained_events)
        self._max_event_bytes = max(1024, max_event_bytes)

    async def discover(self, endpoint: EndpointDescriptor) -> dict[str, Any]:
        A2AEndpointSettings.from_endpoint(endpoint)
        card = await self._resolve_card(endpoint)
        raw = MessageToDict(card, preserving_proto_field_name=False)
        interfaces = []
        for item in raw.get("supportedInterfaces", []):
            if not isinstance(item, dict):
                continue
            interfaces.append(
                {
                    "protocolBinding": item.get("protocolBinding"),
                    "protocolVersion": item.get("protocolVersion"),
                }
            )
        return {
            "endpoint": endpoint.public_view(),
            "agent_card": {
                "name": raw.get("name"),
                "description": raw.get("description"),
                "version": raw.get("version"),
                "capabilities": raw.get("capabilities", {}),
                "defaultInputModes": raw.get("defaultInputModes", []),
                "defaultOutputModes": raw.get("defaultOutputModes", []),
                "skills": raw.get("skills", []),
                "supportedInterfaces": interfaces,
            },
            "native_source": "a2a-sdk.A2ACardResolver",
        }

    async def send(
        self,
        endpoint: EndpointDescriptor,
        *,
        text: str,
        data: dict[str, Any] | None,
        context_ref: str,
        task_id: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        client = await self._create_client(
            endpoint,
            ClientConfig(streaming=True, polling=True),
        )
        try:
            parts = []
            if text:
                parts.append(new_text_part(text, media_type="text/plain"))
            if data is not None:
                parts.append(
                    new_data_part(
                        {"zes_payload": data},
                        media_type="application/json",
                    )
                )
            parts.append(
                new_data_part(
                    {"zes_interaction": metadata.get("zes", {})},
                    media_type="application/json",
                )
            )
            message = new_message(
                parts=parts,
                context_id=context_ref or None,
                task_id=task_id or None,
                role=Role.ROLE_USER,
            )
            if metadata:
                ParseDict(metadata, message.metadata)
            request = SendMessageRequest(message=message)
            events: deque[dict[str, Any]] = deque(maxlen=self._max_retained_events)
            event_count = 0
            async for event in client.send_message(request):
                event_count += 1
                events.append(
                    _bound_native_payload(
                        MessageToDict(event, preserving_proto_field_name=False),
                        self._max_event_bytes,
                    )
                )
            return {
                "events": list(events),
                "event_count": event_count,
                "events_truncated": event_count > len(events),
            }
        finally:
            await client.close()

    async def get_task(
        self, endpoint: EndpointDescriptor, task_id: str
    ) -> dict[str, Any]:
        client = await self._create_client(
            endpoint,
            ClientConfig(streaming=False, polling=True),
        )
        try:
            task = await client.get_task(GetTaskRequest(id=task_id))
            return _bound_native_payload(
                MessageToDict(task, preserving_proto_field_name=False),
                self._max_event_bytes,
            )
        finally:
            await client.close()

    async def cancel_task(
        self, endpoint: EndpointDescriptor, task_id: str
    ) -> dict[str, Any]:
        client = await self._create_client(
            endpoint,
            ClientConfig(streaming=False, polling=True),
        )
        try:
            task = await client.cancel_task(CancelTaskRequest(id=task_id))
            return _bound_native_payload(
                MessageToDict(task, preserving_proto_field_name=False),
                self._max_event_bytes,
            )
        finally:
            await client.close()

    async def _resolve_card(self, endpoint: EndpointDescriptor) -> AgentCard:
        settings = A2AEndpointSettings.from_endpoint(endpoint)
        async with httpx.AsyncClient(timeout=30) as http_client:
            resolver = A2ACardResolver(http_client, settings.base_url)
            return await resolver.get_agent_card(settings.agent_card_path)

    async def _create_client(
        self,
        endpoint: EndpointDescriptor,
        config: ClientConfig,
    ) -> Any:
        settings = A2AEndpointSettings.from_endpoint(endpoint)
        card = self._normalize_protocol_bindings(
            await self._resolve_card(endpoint),
            protocol_mode=settings.protocol_mode,
        )
        return ClientFactory(config).create(card)

    @staticmethod
    def _normalize_protocol_bindings(
        card: AgentCard,
        *,
        protocol_mode: str = "strict-v1",
    ) -> AgentCard:
        """Normalize known A2A binding spellings before official SDK selection.

        LangGraph Agent Server 0.13 emits the standards-facing lowercase
        ``jsonrpc`` spelling while a2a-sdk 1.1.2 currently registers the
        uppercase ``JSONRPC`` enum label. This is a bounded representation
        adapter only; all transport behavior remains in the official SDK.
        """

        normalized = AgentCard()
        normalized.CopyFrom(card)
        aliases = {
            "jsonrpc": TransportProtocol.JSONRPC,
            "http+json": TransportProtocol.HTTP_JSON,
            "grpc": TransportProtocol.GRPC,
        }
        for interface in normalized.supported_interfaces:
            alias = aliases.get(interface.protocol_binding.casefold())
            if alias is not None:
                interface.protocol_binding = alias
            if protocol_mode == "legacy-v0.3":
                interface.protocol_version = PROTOCOL_VERSION_0_3
        return normalized


class InteractionPlane:
    """Provider-neutral interaction substrate with native A2A at the edge."""

    def __init__(
        self,
        registry: WorkspaceRegistry,
        agent_server: AgentServerPlane,
        *,
        endpoints: EndpointRegistry | None = None,
        adapters: dict[str, InteractionAdapter] | None = None,
        client: InteractionAdapter | None = None,
        projections: ProjectionBackend | None = None,
        local_participant_ref: str = "webchat-edge",
    ) -> None:
        self._registry = registry
        self._agent_server = agent_server
        self._endpoints = endpoints or EndpointRegistry()
        self._adapters: dict[str, InteractionAdapter] = {
            "a2a": client or NativeA2AClient(),
            **(adapters or {}),
        }
        self._projections = projections or AgentServerProjectionBackend(agent_server)
        self._local_participant_ref = _require_ref(
            local_participant_ref, "local_participant_ref"
        )
        self._max_request_bytes = max(
            1024,
            int(os.environ.get("BRIDGE_A2A_MAX_REQUEST_BYTES", "200000")),
        )

    def manifest(self) -> dict[str, Any]:
        agent_manifest = self._agent_server.manifest()
        return {
            "state": (
                "available"
                if agent_manifest["state"] == "available"
                else "outbound_only_or_disabled"
            ),
            "stable_core": [
                "participant_ref",
                "endpoint_ref",
                "capability_ref",
                "interaction_ref",
                "context_ref",
                "correlation_ref",
                "message",
                "task",
                "artifact",
                "receipt",
                "delivery_state",
                "trace_context",
                "authority_refs",
            ],
            "native_components": [
                "LangGraph Agent Server A2A endpoint",
                "a2a-sdk 1.1.2 client and Agent Card resolver",
                "Agent Server Threads/Runs/Store",
                "LangSmith/OTel trace correlation",
            ],
            "endpoint_allowlist": self._endpoints.public_view(),
            "registered_adapters": sorted(self._adapters),
            "webchat_adapter": {
                "outbound": "direct A2A client",
                "inbound": "native Agent Server A2A thread plus durable pull projection",
                "presence_authoritative": False,
                "background_model_loop": False,
            },
            "authority": {
                "communication_creates_material_authority": False,
                "role_or_topology_assumptions": False,
                "a2a_task_is_zes_work_item": False,
                "langgraph_run_is_universal_task_identity": False,
            },
        }

    def bootstrap(self, binding: WorkstreamBinding, limit: int = 10) -> dict[str, Any]:
        scope_ref = binding.interaction_thread_id or binding.workstream_ref
        try:
            projections = self._projections.list(scope_ref, limit)
        except Exception as exc:
            return {
                "state": "unavailable",
                "pending_count": 0,
                "items": [],
                "error_type": type(exc).__name__,
            }
        unseen = [
            item for item in projections if item.delivery_state == DeliveryState.UNSEEN
        ]
        return {
            "state": "available",
            "scope_ref": scope_ref,
            "pending_count": len(unseen),
            "items": [item.public_view() for item in unseen[:limit]],
            "full_history_tool": "interaction(action='inbox')",
        }

    async def operate(
        self,
        action: str,
        *,
        workspace_id: str = "",
        endpoint_ref: str = "",
        text: str = "",
        data: dict[str, Any] | None = None,
        context_ref: str = "",
        correlation_ref: str = "",
        task_id: str = "",
        interaction_ref: str = "",
        kind: str = InteractionKind.MESSAGE,
        schema_ref: str = "",
        authority_refs: list[str] | None = None,
        trace_context: dict[str, str] | None = None,
        metadata: dict[str, Any] | None = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        if action == "manifest":
            return self.manifest()
        if action == "discover":
            endpoint = self._endpoints.get(endpoint_ref)
            return await self._adapter(endpoint).discover(endpoint)

        binding = self._binding(workspace_id)
        scope_ref = binding.interaction_thread_id or binding.workstream_ref
        if action == "inbox":
            projections = await asyncio.to_thread(
                self._projections.list, scope_ref, limit
            )
            return {
                "scope_ref": scope_ref,
                "items": [item.public_view() for item in projections],
            }
        if action == "ack":
            current = await asyncio.to_thread(
                self._projections.get,
                scope_ref,
                interaction_ref,
            )
            updated = replace(
                current,
                delivery_state=DeliveryState.ACKNOWLEDGED,
                metadata={**current.metadata, "acknowledged_at": _now()},
            )
            await asyncio.to_thread(self._projections.put, scope_ref, updated)
            return updated.public_view()

        endpoint = self._endpoints.get(endpoint_ref)
        adapter = self._adapter(endpoint)
        if action == "send":
            if not text and data is None:
                raise BridgeError("interaction send requires text or data")
            if text and data is not None:
                raise BridgeError("interaction send accepts text or data, not both")
            _require_payload_size(
                text if data is None else data,
                "interaction payload",
                self._max_request_bytes,
            )
            _require_payload_size(
                metadata or {},
                "interaction metadata",
                self._max_request_bytes,
            )
            if schema_ref:
                _require_ref(schema_ref, "schema_ref")
            for authority_ref in authority_refs or []:
                _require_ref(authority_ref, "authority_ref")
            for key, value in (trace_context or {}).items():
                if key not in {"traceparent", "tracestate", "baggage"}:
                    raise BridgeError("trace_context contains an unsupported key")
                if not isinstance(value, str) or len(value) > 4096:
                    raise BridgeError("trace_context values must be bounded strings")
            clean_context = (
                _require_ref(context_ref, "context_ref") if context_ref else ""
            )
            if task_id:
                _require_ref(task_id, "task_id")
            clean_correlation = (
                _require_ref(correlation_ref, "correlation_ref")
                if correlation_ref
                else str(uuid7())
            )
            native_metadata = {
                **(metadata or {}),
                "zes": {
                    "sender_ref": self._local_participant_ref,
                    "workstream_ref": binding.workstream_ref,
                    "correlation_ref": clean_correlation,
                    "schema_ref": schema_ref or None,
                    "authority_refs": authority_refs or [],
                    "trace_context": trace_context or {},
                    "communication_only": True,
                    "reply_context_ref": binding.interaction_thread_id,
                },
            }
            exchange = await adapter.send(
                endpoint,
                text=text,
                data=data,
                context_ref=clean_context,
                task_id=task_id,
                metadata=native_metadata,
            )
            events = exchange["events"]
            observed = _observe_a2a_events(events)
            projection = InteractionProjection(
                interaction_ref=str(uuid7()),
                scope_ref=scope_ref,
                workstream_ref=binding.workstream_ref,
                direction=InteractionDirection.OUTBOUND,
                kind=kind,
                native_protocol=adapter.protocol_label,
                native_endpoint_ref=endpoint.endpoint_ref,
                peer_ref=endpoint.participant_ref,
                observed_state=observed["state"],
                observed_at=_now(),
                delivery_state=DeliveryState.ACKNOWLEDGED,
                context_ref=clean_context or observed.get("context_id"),
                correlation_ref=clean_correlation,
                native_context_id=observed.get("context_id"),
                native_task_id=observed.get("task_id"),
                native_message_id=observed.get("message_id"),
                agent_server_thread_id=binding.interaction_thread_id,
                artifact_refs=tuple(observed.get("artifact_refs", [])),
                authority_refs=tuple(authority_refs or []),
                trace_context=dict(trace_context or {}),
                summary=(text or "structured data")[:1000],
                metadata={
                    "event_count": exchange["event_count"],
                    "events_truncated": exchange["events_truncated"],
                    "schema_ref": schema_ref or None,
                },
            )
            await asyncio.to_thread(self._projections.put, scope_ref, projection)
            return {
                "projection": projection.public_view(),
                "native_events": events,
            }
        if action == "get":
            _require_ref(task_id, "task_id")
            result = await adapter.get_task(endpoint, task_id)
            return {
                "task": result,
                "native_source": f"{adapter.adapter_id}.get_task",
            }
        if action == "cancel":
            _require_ref(task_id, "task_id")
            result = await adapter.cancel_task(endpoint, task_id)
            return {
                "task": result,
                "native_source": f"{adapter.adapter_id}.cancel_task",
            }
        raise BridgeError(
            "interaction action must be manifest, discover, send, get, cancel, inbox, or ack"
        )

    def _binding(self, workspace_id: str) -> WorkstreamBinding:
        if not workspace_id:
            raise BridgeError("workspace_id is required for this interaction action")
        handle = self._registry.get_handle(workspace_id)
        if handle.workstream is None:
            raise BridgeError("workspace has no bound WebChat workstream")
        return handle.workstream

    def _adapter(self, endpoint: EndpointDescriptor) -> InteractionAdapter:
        try:
            return self._adapters[endpoint.transport]
        except KeyError as exc:
            raise BridgeError(
                f"no interaction adapter is registered for transport {endpoint.transport!r}"
            ) from exc


def _require_payload_size(value: Any, name: str, maximum: int) -> None:
    try:
        payload = (
            value.encode("utf-8")
            if isinstance(value, str)
            else json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        )
    except (TypeError, ValueError) as exc:
        raise BridgeError(f"{name} must be JSON serializable") from exc
    if len(payload) > maximum:
        raise BridgeError(f"{name} exceeds {maximum} bytes")


def _bound_native_payload(value: dict[str, Any], maximum: int) -> dict[str, Any]:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    if len(encoded) <= maximum:
        return value
    observed = _observe_a2a_events(
        [{"task": value}] if "id" in value and "status" in value else [value]
    )
    return {
        "truncated": True,
        "original_bytes": len(encoded),
        "task": {
            "id": observed.get("task_id"),
            "contextId": observed.get("context_id"),
            "status": {"state": observed.get("state")},
            "artifacts": [
                {"artifactId": artifact_ref}
                for artifact_ref in observed.get("artifact_refs", [])
            ],
        },
    }


def _observe_a2a_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    observed: dict[str, Any] = {
        "state": "submitted" if events else "unknown",
        "artifact_refs": [],
    }
    for event in events:
        task = event.get("task") if isinstance(event, dict) else None
        message = event.get("message") if isinstance(event, dict) else None
        status = event.get("statusUpdate") if isinstance(event, dict) else None
        artifact = event.get("artifactUpdate") if isinstance(event, dict) else None
        if isinstance(task, dict):
            observed["task_id"] = task.get("id")
            observed["context_id"] = task.get("contextId")
            task_status = task.get("status", {})
            if isinstance(task_status, dict):
                observed["state"] = task_status.get("state", observed["state"])
            for item in task.get("artifacts", []):
                if isinstance(item, dict) and item.get("artifactId"):
                    observed["artifact_refs"].append(item["artifactId"])
        if isinstance(message, dict):
            observed["message_id"] = message.get("messageId")
            observed["context_id"] = message.get("contextId")
            observed["task_id"] = message.get("taskId")
            observed["state"] = "message"
        if isinstance(status, dict):
            observed["task_id"] = status.get("taskId")
            status_value = status.get("status", {})
            if isinstance(status_value, dict):
                observed["state"] = status_value.get("state", observed["state"])
        if isinstance(artifact, dict):
            observed["task_id"] = artifact.get("taskId")
            item = artifact.get("artifact", {})
            if isinstance(item, dict) and item.get("artifactId"):
                observed["artifact_refs"].append(item["artifactId"])
    observed["artifact_refs"] = sorted(set(observed["artifact_refs"]))
    return observed

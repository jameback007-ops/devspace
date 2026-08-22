from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from a2a.types import AgentCard, AgentInterface
from langchain_core.messages import HumanMessage
from langgraph.store.memory import InMemoryStore

from chatgpt_langchain_bridge.interaction import (
    A2AEndpointSettings,
    DeliveryState,
    EndpointDescriptor,
    EndpointRegistry,
    InteractionDirection,
    InteractionKind,
    InteractionPlane,
    InteractionProjection,
    NativeA2AClient,
)
from chatgpt_langchain_bridge.interaction_graph import builder
from chatgpt_langchain_bridge.registry import (
    BridgeConfig,
    BridgeError,
    WorkspaceRegistry,
)
from chatgpt_langchain_bridge.workstream import WorkstreamBinding


class FakeAgentServer:
    def manifest(self) -> dict[str, Any]:
        return {"state": "available"}


class FakeA2AClient:
    adapter_id = "a2a"
    protocol_label = "a2a/1.0"

    def __init__(self) -> None:
        self.last_send: dict[str, Any] | None = None

    async def discover(self, endpoint: EndpointDescriptor) -> dict[str, Any]:
        return {
            "endpoint": endpoint.public_view(),
            "agent_card": {
                "name": "Peer",
                "version": "1.0",
                "skills": [],
            },
            "native_source": "fake-a2a",
        }

    async def send(self, endpoint: EndpointDescriptor, **kwargs: Any) -> dict[str, Any]:
        self.last_send = {"endpoint": endpoint, **kwargs}
        return {
            "events": [
                {
                    "task": {
                        "id": "task-1",
                        "contextId": "context-1",
                        "status": {"state": "TASK_STATE_COMPLETED"},
                        "artifacts": [{"artifactId": "artifact-1"}],
                    }
                }
            ],
            "event_count": 1,
            "events_truncated": False,
        }

    async def get_task(
        self, endpoint: EndpointDescriptor, task_id: str
    ) -> dict[str, Any]:
        return {"id": task_id, "status": {"state": "TASK_STATE_COMPLETED"}}

    async def cancel_task(
        self, endpoint: EndpointDescriptor, task_id: str
    ) -> dict[str, Any]:
        return {"id": task_id, "status": {"state": "TASK_STATE_CANCELED"}}


class MemoryProjectionBackend:
    def __init__(self) -> None:
        self.values: dict[tuple[str, str], InteractionProjection] = {}

    def put(self, scope_ref: str, projection: InteractionProjection) -> None:
        self.values[(scope_ref, projection.interaction_ref)] = projection

    def list(self, scope_ref: str, limit: int) -> list[InteractionProjection]:
        values = [
            projection
            for (scope, _), projection in self.values.items()
            if scope == scope_ref
        ]
        return sorted(values, key=lambda item: item.observed_at, reverse=True)[:limit]

    def get(self, scope_ref: str, interaction_ref: str) -> InteractionProjection:
        try:
            return self.values[(scope_ref, interaction_ref)]
        except KeyError as exc:
            raise BridgeError("interaction projection was not found") from exc


def make_plane(
    tmp_path: Path,
    *,
    client: FakeA2AClient | None = None,
    projections: MemoryProjectionBackend | None = None,
) -> tuple[InteractionPlane, WorkspaceRegistry, str, WorkstreamBinding]:
    registry = WorkspaceRegistry(BridgeConfig(allowed_roots=(tmp_path.resolve(),)))
    binding = WorkstreamBinding(
        workstream_ref="mission/interaction",
        trace_thread_id="mission/interaction",
        source="webchat_supplied",
        state="resolved_existing_agent_thread",
        bound_at="2026-08-23T00:00:00+00:00",
        agent_thread_id="runtime-thread-1",
        interaction_thread_id="interaction-thread-1",
    )
    workspace_id = registry.open(str(tmp_path), workstream=binding)["workspace_id"]
    plane = InteractionPlane(
        registry,
        FakeAgentServer(),  # type: ignore[arg-type]
        endpoints=EndpointRegistry(
            {
                "peer-alpha": EndpointDescriptor(
                    endpoint_ref="peer-alpha",
                    participant_ref="participant-alpha",
                    transport="a2a",
                    capability_refs=("code.review", "research.open-world"),
                    adapter_config={
                        "base_url": "https://peer.example.invalid",
                    },
                )
            }
        ),
        client=client or FakeA2AClient(),  # type: ignore[arg-type]
        projections=projections or MemoryProjectionBackend(),
    )
    return plane, registry, workspace_id, binding


def test_endpoint_registry_is_allowlisted_and_hides_network_location(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "BRIDGE_A2A_ENDPOINTS",
        '{"env-peer":{"base_url":"https://env.example.invalid"}}',
    )
    registry = EndpointRegistry({})
    assert registry.public_view() == []

    endpoint = EndpointDescriptor(
        endpoint_ref="peer-alpha",
        participant_ref="participant-alpha",
        transport="a2a",
        adapter_config={"base_url": "https://peer.example.invalid"},
    )
    assert endpoint.public_view() == {
        "endpoint_ref": "peer-alpha",
        "participant_ref": "participant-alpha",
        "transport": "a2a",
        "capability_refs": [],
        "configured": True,
    }

    with pytest.raises(BridgeError, match="must not contain credentials"):
        A2AEndpointSettings.from_endpoint(
            EndpointDescriptor(
                endpoint_ref="unsafe",
                participant_ref="unsafe",
                transport="a2a",
                adapter_config={"base_url": "https://user:secret@example.invalid"},
            )
        )


def test_native_client_normalizes_known_protocol_binding_spellings() -> None:
    card = AgentCard(
        name="peer",
        description="peer",
        version="1.0",
        supported_interfaces=[
            AgentInterface(
                url="https://peer.example.invalid/a2a",
                protocol_binding="jsonrpc",
                protocol_version="1.0",
            )
        ],
    )

    normalized = NativeA2AClient._normalize_protocol_bindings(card)
    legacy = NativeA2AClient._normalize_protocol_bindings(
        card,
        protocol_mode="legacy-v0.3",
    )

    assert card.supported_interfaces[0].protocol_binding == "jsonrpc"
    assert normalized.supported_interfaces[0].protocol_binding == "JSONRPC"
    assert legacy.supported_interfaces[0].protocol_version == "0.3"


@pytest.mark.asyncio
async def test_agent_card_projection_omits_transport_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    card = AgentCard(
        name="peer",
        description="peer",
        version="1.0",
        supported_interfaces=[
            AgentInterface(
                url="https://private-peer.example.invalid/a2a",
                protocol_binding="JSONRPC",
                protocol_version="1.0",
            )
        ],
    )
    client = NativeA2AClient()

    async def resolve(_: EndpointDescriptor) -> AgentCard:
        return card

    monkeypatch.setattr(client, "_resolve_card", resolve)
    endpoint = EndpointDescriptor(
        endpoint_ref="peer-alpha",
        participant_ref="participant-alpha",
        transport="a2a",
        adapter_config={"base_url": "https://private-peer.example.invalid"},
    )

    discovered = await client.discover(endpoint)

    interface = discovered["agent_card"]["supportedInterfaces"][0]
    assert interface == {
        "protocolBinding": "JSONRPC",
        "protocolVersion": "1.0",
    }
    assert "private-peer" not in str(discovered)


@pytest.mark.asyncio
async def test_outbound_a2a_uses_native_client_and_neutral_projection(
    tmp_path: Path,
) -> None:
    client = FakeA2AClient()
    projections = MemoryProjectionBackend()
    plane, _, workspace_id, binding = make_plane(
        tmp_path,
        client=client,
        projections=projections,
    )

    result = await plane.operate(
        "send",
        workspace_id=workspace_id,
        endpoint_ref="peer-alpha",
        text="Inspect the bounded candidate.",
        kind="request",
        schema_ref="schema.review-request.v1",
        authority_refs=["authority:communication-only"],
        trace_context={
            "traceparent": "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
        },
        metadata={"zes": {"communication_only": False}},
    )

    projection = result["projection"]
    assert projection["native_task_id"] == "task-1"
    assert projection["artifact_refs"] == ["artifact-1"]
    assert projection["delivery_state"] == DeliveryState.ACKNOWLEDGED
    assert projection["authority"]["communication_only"] is True
    assert projection["authority"]["creates_task_or_workspace_authority"] is False
    assert client.last_send is not None
    assert client.last_send["metadata"]["zes"]["communication_only"] is True
    assert (
        client.last_send["metadata"]["zes"]["reply_context_ref"]
        == binding.interaction_thread_id
    )
    assert plane.bootstrap(binding)["pending_count"] == 0


@pytest.mark.asyncio
async def test_native_task_get_and_cancel_remain_adapter_owned(tmp_path: Path) -> None:
    plane, _, workspace_id, _ = make_plane(tmp_path)

    found = await plane.operate(
        "get",
        workspace_id=workspace_id,
        endpoint_ref="peer-alpha",
        task_id="task-1",
    )
    cancelled = await plane.operate(
        "cancel",
        workspace_id=workspace_id,
        endpoint_ref="peer-alpha",
        task_id="task-1",
    )

    assert found["task"]["status"]["state"] == "TASK_STATE_COMPLETED"
    assert cancelled["task"]["status"]["state"] == "TASK_STATE_CANCELED"
    assert found["native_source"] == "a2a.get_task"
    assert cancelled["native_source"] == "a2a.cancel_task"


@pytest.mark.asyncio
async def test_webchat_inbound_projection_is_durable_pull_and_acknowledged(
    tmp_path: Path,
) -> None:
    projections = MemoryProjectionBackend()
    plane, _, workspace_id, binding = make_plane(tmp_path, projections=projections)
    inbound = InteractionProjection(
        interaction_ref="interaction-inbound-1",
        scope_ref="interaction-thread-1",
        workstream_ref=binding.workstream_ref,
        direction=InteractionDirection.INBOUND,
        kind=InteractionKind.MESSAGE,
        native_protocol="a2a/1.0",
        native_endpoint_ref="native-agent-server-a2a",
        peer_ref="participant-alpha",
        observed_state="received",
        observed_at="2026-08-23T00:01:00+00:00",
        summary="Peer result is ready.",
    )
    projections.put("interaction-thread-1", inbound)

    bootstrap = plane.bootstrap(binding)
    assert bootstrap["pending_count"] == 1
    assert bootstrap["items"][0]["summary"] == "Peer result is ready."

    acknowledged = await plane.operate(
        "ack",
        workspace_id=workspace_id,
        interaction_ref="interaction-inbound-1",
    )
    assert acknowledged["delivery_state"] == DeliveryState.ACKNOWLEDGED
    assert plane.bootstrap(binding)["pending_count"] == 0


@pytest.mark.asyncio
async def test_unknown_endpoint_and_oversized_payload_are_rejected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BRIDGE_A2A_MAX_REQUEST_BYTES", "1024")
    plane, _, workspace_id, _ = make_plane(tmp_path)

    with pytest.raises(BridgeError, match="allowlist"):
        await plane.operate(
            "send",
            workspace_id=workspace_id,
            endpoint_ref="https://caller-supplied.invalid",
            text="not allowed",
        )

    with pytest.raises(BridgeError, match="exceeds 1024 bytes"):
        await plane.operate(
            "send",
            workspace_id=workspace_id,
            endpoint_ref="peer-alpha",
            text="x" * 1025,
        )


def test_interaction_manifest_is_topology_and_role_neutral(tmp_path: Path) -> None:
    plane, _, _, _ = make_plane(tmp_path)
    manifest = plane.manifest()

    assert manifest["authority"]["role_or_topology_assumptions"] is False
    assert manifest["authority"]["a2a_task_is_zes_work_item"] is False
    assert "participant_ref" in manifest["stable_core"]
    assert "lead" not in str(manifest).lower()
    assert "researcher" not in str(manifest).lower()


@pytest.mark.asyncio
async def test_unknown_transport_requires_a_registered_adapter(tmp_path: Path) -> None:
    registry = WorkspaceRegistry(BridgeConfig(allowed_roots=(tmp_path.resolve(),)))
    binding = WorkstreamBinding(
        workstream_ref="mission/unknown-adapter",
        trace_thread_id="mission/unknown-adapter",
        source="webchat_supplied",
        state="resolved_existing_agent_thread",
        bound_at="2026-08-23T00:00:00+00:00",
        interaction_thread_id="interaction-thread-unknown",
    )
    workspace_id = registry.open(str(tmp_path), workstream=binding)["workspace_id"]
    plane = InteractionPlane(
        registry,
        FakeAgentServer(),  # type: ignore[arg-type]
        endpoints=EndpointRegistry(
            {
                "internal-peer": EndpointDescriptor(
                    endpoint_ref="internal-peer",
                    participant_ref="participant/internal",
                    transport="langgraph-internal",
                )
            }
        ),
        projections=MemoryProjectionBackend(),
    )

    with pytest.raises(BridgeError, match="no interaction adapter"):
        await plane.operate(
            "discover",
            workspace_id=workspace_id,
            endpoint_ref="internal-peer",
        )


def test_native_interaction_graph_writes_agent_server_store_projection() -> None:
    store = InMemoryStore()
    graph = builder.compile(store=store, name="interaction-test")

    result = graph.invoke(
        {
            "messages": [
                HumanMessage(
                    content="Please inspect this artifact.",
                    id="message-1",
                    additional_kwargs={
                        "zes": {
                            "sender_ref": "participant-alpha",
                            "workstream_ref": "mission/interaction",
                            "context_ref": "context/review",
                            "authority_refs": ["authority:communication-only"],
                            "trace_context": {"traceparent": "00-test"},
                            "schema_ref": "schema.review-request.v1",
                        }
                    },
                )
            ]
        },
        {"configurable": {"thread_id": "interaction-thread-1"}},
    )

    items = store.search(
        ("chatgpt-langchain-bridge", "interaction-projection", "interaction-thread-1")
    )
    assert len(items) == 1
    projection = items[0].value
    assert projection["direction"] == "inbound"
    assert projection["workstream_ref"] == "mission/interaction"
    assert projection["peer_ref"] == "participant-alpha"
    assert projection["delivery_state"] == "unseen"
    assert projection["metadata"]["communication_only"] is True
    assert result["messages"][-1].content == "Interaction accepted for durable pull."


def test_native_interaction_graph_accepts_structured_data_without_text() -> None:
    store = InMemoryStore()
    graph = builder.compile(store=store, name="interaction-data-test")

    graph.invoke(
        {
            "zes_interaction": {
                "sender_ref": "participant-structured",
                "workstream_ref": "mission/structured",
                "context_ref": "context/structured",
                "schema_ref": "schema.structured-message.v1",
                "authority_refs": [],
                "trace_context": {},
            },
            "zes_payload": {"result_ref": "artifact/result-1"},
        },
        {"configurable": {"thread_id": "interaction-thread-structured"}},
    )

    items = store.search(
        (
            "chatgpt-langchain-bridge",
            "interaction-projection",
            "interaction-thread-structured",
        )
    )
    assert len(items) == 1
    projection = items[0].value
    assert projection["peer_ref"] == "participant-structured"
    assert projection["summary"] == "schema.structured-message.v1"
    assert projection["metadata"]["structured_payload_present"] is True


def test_invalid_projection_enum_is_rejected() -> None:
    with pytest.raises(BridgeError, match="invalid enum"):
        InteractionProjection(
            interaction_ref="interaction-1",
            scope_ref="scope-1",
            workstream_ref="workstream-1",
            direction="sideways",
            kind="message",
            native_protocol="a2a/1.0",
            native_endpoint_ref="peer-alpha",
            peer_ref="participant-alpha",
            observed_state="received",
            observed_at="2026-08-23T00:00:00+00:00",
        )

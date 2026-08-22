from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AIMessage, AnyMessage, BaseMessage
from langgraph.config import get_config, get_store
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langsmith import uuid7


_NAMESPACE_PREFIX = (
    "chatgpt-langchain-bridge",
    "interaction-projection",
)


class InteractionState(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    zes_interaction: dict[str, Any]
    zes_payload: dict[str, Any]


def _message_summary(message: BaseMessage) -> str:
    content = message.content
    if isinstance(content, str):
        return content[:1000]
    return str(content)[:1000]


def _accept_interaction(state: InteractionState) -> dict[str, Any]:
    config = get_config()
    thread_id = str(config.get("configurable", {}).get("thread_id") or "")
    if not thread_id:
        raise RuntimeError("interaction graph requires a native thread_id")
    messages = state.get("messages", [])
    message = messages[-1] if messages else None
    zes_metadata = state.get("zes_interaction", {})
    if not isinstance(zes_metadata, dict):
        zes_metadata = {}
    if not zes_metadata and message is not None:
        fallback = message.additional_kwargs.get("zes", {})
        if isinstance(fallback, dict):
            zes_metadata = fallback
    payload = state.get("zes_payload", {})
    if not isinstance(payload, dict):
        payload = {}
    interaction_ref = str(uuid7())
    summary = (
        _message_summary(message)
        if message is not None
        else str(zes_metadata.get("schema_ref") or "Structured interaction payload")
    )
    projection = {
        "interaction_ref": interaction_ref,
        "scope_ref": thread_id,
        "workstream_ref": str(zes_metadata.get("workstream_ref") or thread_id),
        "direction": "inbound",
        "kind": "message",
        "native_protocol": "a2a/1.0",
        "native_endpoint_ref": "native-agent-server-a2a",
        "peer_ref": str(
            zes_metadata.get("sender_ref")
            or (
                message.additional_kwargs.get("sender_ref")
                if message is not None
                else None
            )
            or "external-peer"
        ),
        "observed_state": "received",
        "observed_at": datetime.now(UTC).isoformat(),
        "delivery_state": "unseen",
        "context_ref": str(zes_metadata.get("context_ref") or thread_id),
        "native_message_id": (
            str(message.id or "") or None if message is not None else None
        ),
        "agent_server_thread_id": thread_id,
        "artifact_refs": [],
        "authority_refs": list(zes_metadata.get("authority_refs") or []),
        "trace_context": dict(zes_metadata.get("trace_context") or {}),
        "summary": summary,
        "metadata": {
            "source": "langgraph_agent_server_native_a2a",
            "communication_only": True,
            "schema_ref": zes_metadata.get("schema_ref"),
            "structured_payload_present": bool(payload),
        },
    }
    get_store().put((*_NAMESPACE_PREFIX, thread_id), interaction_ref, projection)
    return {
        "messages": [
            AIMessage(
                content="Interaction accepted for durable pull.",
                additional_kwargs={"interaction_ref": interaction_ref},
            )
        ]
    }


builder = StateGraph(InteractionState)
builder.add_node("accept_interaction", _accept_interaction)
builder.add_edge(START, "accept_interaction")
builder.add_edge("accept_interaction", END)

# Agent Server provides the native checkpointer and Store.
graph = builder.compile(name="chatgpt_capability_bridge_interaction")

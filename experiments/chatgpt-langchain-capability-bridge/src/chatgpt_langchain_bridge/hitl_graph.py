from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt


class BridgeHitlState(TypedDict, total=False):
    """Deterministic native interrupt graph used for capability qualification.

    The graph contains no model. It proves that WebChat can create an Agent
    Server run, observe a native LangGraph interrupt, and resume that exact
    thread with a native ``Command(resume=...)`` payload through MCP.
    """

    action_request: dict[str, Any]
    review: dict[str, Any]
    status: str


def request_review(state: BridgeHitlState) -> dict[str, Any]:
    action = state.get(
        "action_request",
        {"name": "qualification_action", "args": {}},
    )
    response = interrupt(
        {
            "action_requests": [action],
            "review_configs": [
                {
                    "action_name": action.get("name", "qualification_action"),
                    "allowed_decisions": ["approve", "edit", "reject", "respond"],
                }
            ],
        }
    )
    return {"review": response, "status": "resumed"}


builder = StateGraph(BridgeHitlState)
builder.add_node("request_review", request_review)
builder.add_edge(START, "request_review")
builder.add_edge("request_review", END)

# Agent Server supplies the durable checkpointer and Store.
graph = builder.compile(name="chatgpt_capability_bridge_hitl")

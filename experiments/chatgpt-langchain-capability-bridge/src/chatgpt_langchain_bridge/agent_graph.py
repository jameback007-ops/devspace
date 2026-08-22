from __future__ import annotations

import operator
from typing import Annotated, Any, TypedDict

from langchain.agents.middleware.todo import Todo
from langgraph.graph import END, START, StateGraph


class BridgeAgentServerState(TypedDict, total=False):
    """Minimal deterministic graph required by Agent Server.

    This graph intentionally contains no model. It demonstrates that the MCP
    capability route can coexist with native Agent Server runs, threads,
    checkpoints, stores, authentication, and deployment infrastructure without
    handing the coding loop to another LLM.
    """

    events: Annotated[list[dict[str, Any]], operator.add]
    latest: dict[str, Any]
    todos: list[Todo]


def record(state: BridgeAgentServerState) -> dict[str, Any]:
    events = state.get("events", [])
    return {"latest": events[-1] if events else state.get("latest", {})}


builder = StateGraph(BridgeAgentServerState)
builder.add_node("record", record)
builder.add_edge(START, "record")
builder.add_edge("record", END)

# Agent Server supplies its managed checkpointer and store at deployment time.
graph = builder.compile(name="chatgpt_capability_bridge_journal")

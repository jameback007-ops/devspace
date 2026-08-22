from __future__ import annotations

import operator
import sqlite3
from pathlib import Path
from threading import RLock
from typing import Annotated, Any, Protocol, TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.config import get_store
from langgraph.graph import END, START, StateGraph


class JournalState(TypedDict, total=False):
    events: Annotated[list[dict[str, Any]], operator.add]
    latest: dict[str, Any]


def _identity_node(_: JournalState) -> dict[str, Any]:
    return {}


class Journal(Protocol):
    def record(self, thread_id: str, event: dict[str, Any]) -> dict[str, Any]: ...

    def read(self, thread_id: str) -> dict[str, Any]: ...


class CheckpointJournal:
    """Durable generic state journal backed by native LangGraph checkpoints."""

    def __init__(self, database_path: Path):
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(database_path, check_same_thread=False)
        self._saver = SqliteSaver(self._connection)
        builder = StateGraph(JournalState)
        builder.add_node("record", _identity_node)
        builder.add_edge(START, "record")
        builder.add_edge("record", END)
        self._graph = builder.compile(checkpointer=self._saver, name="bridge_journal")
        self._lock = RLock()

    def record(self, thread_id: str, event: dict[str, Any]) -> dict[str, Any]:
        config = {"configurable": {"thread_id": thread_id}}
        with self._lock:
            self._graph.invoke({"events": [event], "latest": event}, config=config)
            return self.read(thread_id)

    def read(self, thread_id: str) -> dict[str, Any]:
        config = {"configurable": {"thread_id": thread_id}}
        with self._lock:
            snapshot = self._graph.get_state(config)
        values = dict(snapshot.values) if snapshot.values else {}
        return {
            "thread_id": thread_id,
            "events": values.get("events", []),
            "latest": values.get("latest"),
            "checkpoint_id": snapshot.config.get("configurable", {}).get(
                "checkpoint_id"
            )
            if snapshot.config
            else None,
        }

    def close(self) -> None:
        self._connection.close()


class AgentServerStoreJournal:
    """Use Agent Server's native Store from a custom-route request context."""

    _namespace = ("chatgpt-langchain-capability-bridge", "checkpoints")

    def record(self, thread_id: str, event: dict[str, Any]) -> dict[str, Any]:
        store = get_store()
        current = store.get(self._namespace, thread_id)
        events = list(current.value.get("events", [])) if current else []
        events.append(event)
        value = {"events": events, "latest": event}
        store.put(self._namespace, thread_id, value)
        return {
            "thread_id": thread_id,
            **value,
            "checkpoint_id": None,
            "storage": "agent_server_store",
        }

    def read(self, thread_id: str) -> dict[str, Any]:
        item = get_store().get(self._namespace, thread_id)
        value = item.value if item else {"events": [], "latest": None}
        return {
            "thread_id": thread_id,
            **value,
            "checkpoint_id": None,
            "storage": "agent_server_store",
        }

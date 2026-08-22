import os
import sqlite3
from pathlib import Path
from threading import RLock
from typing import Any, Protocol, TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.config import get_store
from langgraph.graph import END, START, StateGraph


class JournalState(TypedDict, total=False):
    events: list[dict[str, Any]]
    latest: dict[str, Any]
    total_event_count: int


def _identity_node(_: JournalState) -> dict[str, Any]:
    return {}


class Journal(Protocol):
    def record(self, thread_id: str, event: dict[str, Any]) -> dict[str, Any]: ...

    def read(self, thread_id: str) -> dict[str, Any]: ...

    def read_latest(self, thread_id: str) -> dict[str, Any]: ...


class CheckpointJournal:
    """Durable generic state journal backed by native LangGraph checkpoints."""

    def __init__(self, database_path: Path, max_events: int | None = None):
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self._max_events = max(
            1,
            max_events
            if max_events is not None
            else int(os.environ.get("BRIDGE_CHECKPOINT_MAX_EVENTS", "200")),
        )
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
            current = self._read_unlocked(thread_id)
            events = [*current["events"], event][-self._max_events :]
            total_event_count = int(current.get("total_event_count", 0)) + 1
            self._graph.invoke(
                {
                    "events": events,
                    "latest": event,
                    "total_event_count": total_event_count,
                },
                config=config,
            )
            return self._read_unlocked(thread_id)

    def read(self, thread_id: str) -> dict[str, Any]:
        with self._lock:
            return self._read_unlocked(thread_id)

    def read_latest(self, thread_id: str) -> dict[str, Any]:
        with self._lock:
            current = self._read_unlocked(thread_id)
        return {
            "thread_id": thread_id,
            "latest": current.get("latest"),
            "checkpoint_id": current.get("checkpoint_id"),
            "storage": current.get("storage", "langgraph_sqlite_checkpoint"),
            "retained_event_count": len(current.get("events", [])),
            "total_event_count": int(current.get("total_event_count", 0)),
        }

    def _read_unlocked(self, thread_id: str) -> dict[str, Any]:
        config = {"configurable": {"thread_id": thread_id}}
        snapshot = self._graph.get_state(config)
        values = dict(snapshot.values) if snapshot.values else {}
        return {
            "thread_id": thread_id,
            "events": values.get("events", []),
            "latest": values.get("latest"),
            "retained_event_count": len(values.get("events", [])),
            "total_event_count": int(values.get("total_event_count", 0)),
            "retention_limit": self._max_events,
            "checkpoint_id": snapshot.config.get("configurable", {}).get(
                "checkpoint_id"
            )
            if snapshot.config
            else None,
            "storage": "langgraph_sqlite_checkpoint",
        }

    def close(self) -> None:
        self._connection.close()


class AgentServerStoreJournal:
    """Use Agent Server's native Store from a custom-route request context."""

    _namespace = ("chatgpt-langchain-capability-bridge", "checkpoints")

    def __init__(self, max_events: int | None = None) -> None:
        self._max_events = max(
            1,
            max_events
            if max_events is not None
            else int(os.environ.get("BRIDGE_CHECKPOINT_MAX_EVENTS", "200")),
        )
        self._lock = RLock()

    def record(self, thread_id: str, event: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            store = get_store()
            current = store.get(self._namespace, thread_id)
            events = list(current.value.get("events", [])) if current else []
            events.append(event)
            total_event_count = (
                int(current.value.get("total_event_count", len(events) - 1)) + 1
                if current
                else 1
            )
            value = {
                "events": events[-self._max_events :],
                "latest": event,
                "total_event_count": total_event_count,
            }
            store.put(self._namespace, thread_id, value)
            return self._public(thread_id, value)

    def read(self, thread_id: str) -> dict[str, Any]:
        with self._lock:
            item = get_store().get(self._namespace, thread_id)
            value = (
                item.value
                if item
                else {"events": [], "latest": None, "total_event_count": 0}
            )
            return self._public(thread_id, value)

    def read_latest(self, thread_id: str) -> dict[str, Any]:
        current = self.read(thread_id)
        return {
            "thread_id": thread_id,
            "latest": current.get("latest"),
            "checkpoint_id": None,
            "storage": "agent_server_store",
            "retained_event_count": current["retained_event_count"],
            "total_event_count": current["total_event_count"],
        }

    def _public(self, thread_id: str, value: dict[str, Any]) -> dict[str, Any]:
        events = list(value.get("events", []))[-self._max_events :]
        return {
            "thread_id": thread_id,
            "events": events,
            "latest": value.get("latest"),
            "retained_event_count": len(events),
            "total_event_count": int(value.get("total_event_count", len(events))),
            "retention_limit": self._max_events,
            "checkpoint_id": None,
            "storage": "agent_server_store",
        }

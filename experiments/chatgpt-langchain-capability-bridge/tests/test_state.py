from __future__ import annotations

from pathlib import Path

from langgraph.store.memory import InMemoryStore

from chatgpt_langchain_bridge import state as state_module
from chatgpt_langchain_bridge.state import AgentServerStoreJournal, CheckpointJournal


def test_langgraph_checkpoint_persists_across_process_objects(tmp_path: Path) -> None:
    database = tmp_path / "journal.sqlite"
    first = CheckpointJournal(database)
    first.record(
        "thread-1",
        {
            "mission_ref": "coding-smoke",
            "frontier": "test is failing",
            "next_action": "repair source",
        },
    )
    first.close()

    second = CheckpointJournal(database)
    state = second.read("thread-1")
    second.close()

    assert len(state["events"]) == 1
    assert state["retained_event_count"] == 1
    assert state["total_event_count"] == 1
    assert state["latest"]["next_action"] == "repair source"
    assert state["checkpoint_id"]


def test_agent_server_store_journal_uses_native_store(monkeypatch) -> None:
    store = InMemoryStore()
    monkeypatch.setattr(state_module, "get_store", lambda: store)
    journal = AgentServerStoreJournal()

    recorded = journal.record(
        "thread-native",
        {"frontier": "custom route", "next_action": "read back"},
    )
    reread = journal.read("thread-native")

    assert recorded["storage"] == "agent_server_store"
    assert reread["latest"]["frontier"] == "custom route"
    assert len(reread["events"]) == 1


def test_checkpoint_journal_retains_only_bounded_current_events(tmp_path: Path) -> None:
    journal = CheckpointJournal(tmp_path / "bounded.sqlite", max_events=2)
    try:
        for index in range(4):
            journal.record("thread-bounded", {"index": index})
        state = journal.read("thread-bounded")
        latest = journal.read_latest("thread-bounded")
    finally:
        journal.close()

    assert [item["index"] for item in state["events"]] == [2, 3]
    assert state["retained_event_count"] == 2
    assert state["total_event_count"] == 4
    assert latest["latest"] == {"index": 3}
    assert latest["retained_event_count"] == 2
    assert latest["total_event_count"] == 4


def test_agent_server_store_journal_retention_is_bounded(monkeypatch) -> None:
    store = InMemoryStore()
    monkeypatch.setattr(state_module, "get_store", lambda: store)
    journal = AgentServerStoreJournal(max_events=2)

    for index in range(4):
        journal.record("thread-native-bounded", {"index": index})
    state = journal.read("thread-native-bounded")

    assert [item["index"] for item in state["events"]] == [2, 3]
    assert state["retained_event_count"] == 2
    assert state["total_event_count"] == 4

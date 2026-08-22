from __future__ import annotations

from typing import Any

import pytest

from chatgpt_langchain_bridge.agent_server_plane import (
    AgentServerPlane,
    AgentServerPlaneConfig,
)
from chatgpt_langchain_bridge.registry import BridgeError


class FakeThreads:
    def __init__(self) -> None:
        self.created = 0
        self.values: dict[str, dict[str, Any]] = {}
        self.states: dict[str, dict[str, Any]] = {}

    def create(self, **kwargs):
        self.created += 1
        value = {"thread_id": f"thread-{self.created}", **kwargs}
        self.values[value["thread_id"]] = value
        self.states[value["thread_id"]] = {}
        return value

    def get(self, thread_id: str):
        return {**self.values[thread_id], "status": "idle"}

    def get_state(self, thread_id: str):
        return {"thread_id": thread_id, "values": self.states[thread_id]}

    def get_history(self, thread_id: str, *, limit: int):
        return [{"thread_id": thread_id, "checkpoint": index} for index in range(limit)]

    def search(self, **kwargs):
        metadata = kwargs.get("metadata") or {}
        return [
            value
            for value in self.values.values()
            if all(
                value.get("metadata", {}).get(key) == item
                for key, item in metadata.items()
            )
        ]

    def update_state(self, thread_id: str, values: Any):
        if isinstance(values, dict):
            self.states[thread_id].update(values)
        return {"thread_id": thread_id, "values": self.states[thread_id]}

    def update(self, thread_id: str, *, metadata: dict[str, Any], **kwargs):
        self.values[thread_id]["metadata"] = metadata
        return self.values[thread_id]

    def delete(self, thread_id: str) -> None:
        self.values.pop(thread_id, None)


class FakeRuns:
    def create(self, thread_id, assistant_id, **kwargs):
        return {
            "thread_id": thread_id,
            "assistant_id": assistant_id,
            "run_id": "run-1",
            "status": "pending",
            **kwargs,
        }

    def wait(self, thread_id, assistant_id, **kwargs):
        return {
            "thread_id": thread_id,
            "assistant_id": assistant_id,
            "done": True,
            **kwargs,
        }

    def get(self, thread_id: str, run_id: str):
        return {"thread_id": thread_id, "run_id": run_id, "status": "success"}

    def join(self, thread_id: str, run_id: str):
        return {"thread_id": thread_id, "run_id": run_id, "result": "ok"}

    def list(self, thread_id: str, *, limit: int):
        return [
            {"thread_id": thread_id, "run_id": f"run-{index}"} for index in range(limit)
        ]

    def join_stream(self, thread_id: str, run_id: str, **kwargs):
        yield {"event": "metadata", "run_id": run_id}
        yield {"event": "values", "data": {"done": True}}

    def cancel(self, thread_id: str, run_id: str, **kwargs) -> None:
        return None


class FakeStore:
    def __init__(self) -> None:
        self.values: dict[tuple[tuple[str, ...], str], dict[str, Any]] = {}

    def put_item(self, namespace, key, value):
        self.values[(tuple(namespace), key)] = value

    def get_item(self, namespace, key):
        return {
            "namespace": list(namespace),
            "key": key,
            "value": self.values[(tuple(namespace), key)],
        }

    def search_items(self, namespace, **kwargs):
        return {"items": [{"namespace": list(namespace), **kwargs}]}

    def delete_item(self, namespace, key):
        self.values.pop((tuple(namespace), key), None)

    def list_namespaces(self, **kwargs):
        return {"namespaces": [["bridge", "test"]], **kwargs}


class FakeClient:
    def __init__(self) -> None:
        self.threads = FakeThreads()
        self.runs = FakeRuns()
        self.store = FakeStore()


def make_plane() -> AgentServerPlane:
    client = FakeClient()
    return AgentServerPlane(
        AgentServerPlaneConfig(
            url="http://agent-server.test",
            allowed_assistant_ids=("bridge_journal", "bridge_interaction"),
            specialist_assistants=(("research", "assistant-research"),),
            store_namespace_prefix=("bridge-runtime",),
            thread_metadata_key="bridge_owner",
            thread_metadata_value="test",
        ),
        client_factory=lambda **_: client,
    )


def test_native_thread_run_and_store_projections() -> None:
    plane = make_plane()
    thread = plane.thread("create", graph_id="bridge_journal")
    run = plane.run(
        "create",
        thread_id=thread["thread_id"],
        assistant_id="bridge_journal",
        run_input={"events": [{"kind": "test"}]},
    )
    events = plane.run(
        "events",
        thread_id=thread["thread_id"],
        run_id=run["run_id"],
    )
    plane.store(
        "put",
        namespace=["bridge", "test"],
        key="state",
        value={"validated": True},
    )
    stored = plane.store(
        "get",
        namespace=["bridge", "test"],
        key="state",
    )

    assert run["stream_resumable"] is True
    assert [event["event"] for event in events["events"]] == ["metadata", "values"]
    assert stored["value"]["validated"] is True
    assert stored["namespace"] == ["bridge-runtime", "bridge", "test"]
    assert thread["metadata"]["bridge_owner"] == "test"


def test_workstream_binding_creates_then_resolves_native_thread() -> None:
    plane = make_plane()

    created = plane.bind_workstream("webchat-workstream-1")
    resolved = plane.bind_workstream("webchat-workstream-1")

    assert created["state"] == "created_agent_thread"
    assert resolved["state"] == "resolved_existing_agent_thread"
    assert resolved["thread_id"] == created["thread_id"]
    assert resolved["interaction_thread_id"] == created["interaction_thread_id"]
    assert resolved["interaction_thread_id"] != resolved["thread_id"]
    assert resolved["metadata"]["bridge_workstream_ref"] == "webchat-workstream-1"
    assert resolved["metadata"]["bridge_owner"] == "test"
    assert resolved["metadata"]["bridge_reasoning_owner"] == "chatgpt_webchat"


def test_workstream_binding_rejects_duplicate_native_threads() -> None:
    client = FakeClient()
    metadata = {
        "bridge_owner": "test",
        "bridge_workstream_ref": "duplicate",
        "bridge_thread_role": "runtime",
        "bridge_reasoning_owner": "chatgpt_webchat",
    }
    client.threads.create(graph_id="bridge_journal", metadata=metadata)
    client.threads.create(graph_id="bridge_journal", metadata=metadata)
    plane = AgentServerPlane(
        AgentServerPlaneConfig(
            url="http://agent-server.test",
            allowed_assistant_ids=("bridge_journal", "bridge_interaction"),
            thread_metadata_key="bridge_owner",
            thread_metadata_value="test",
        ),
        client_factory=lambda **_: client,
    )

    with pytest.raises(BridgeError, match="multiple Agent Server threads"):
        plane.bind_workstream("duplicate")


def test_workstream_binding_migrates_legacy_runtime_thread() -> None:
    client = FakeClient()
    legacy = client.threads.create(
        graph_id="bridge_journal",
        metadata={
            "bridge_owner": "test",
            "bridge_workstream_ref": "legacy-workstream",
            "bridge_reasoning_owner": "chatgpt_webchat",
        },
    )
    plane = AgentServerPlane(
        AgentServerPlaneConfig(
            url="http://agent-server.test",
            allowed_assistant_ids=("bridge_journal", "bridge_interaction"),
            thread_metadata_key="bridge_owner",
            thread_metadata_value="test",
        ),
        client_factory=lambda **_: client,
    )

    binding = plane.bind_workstream("legacy-workstream")

    assert binding["state"] == "migrated_legacy_agent_thread"
    assert binding["thread_id"] == legacy["thread_id"]
    assert (
        client.threads.values[legacy["thread_id"]]["metadata"]["bridge_thread_role"]
        == "runtime"
    )


def test_optional_specialist_is_explicit_and_allowlisted() -> None:
    plane = make_plane()
    listing = plane.specialist("list")
    started = plane.specialist(
        "start",
        specialist="research",
        task={"question": "challenge the architecture"},
    )

    assert listing["default_delegation"] is False
    assert listing["reasoning_owner"] == "chatgpt_webchat"
    assert started["specialist"] == "research"
    assert started["run"]["assistant_id"] == "assistant-research"


def test_native_todo_schema_uses_agent_server_thread_state() -> None:
    plane = make_plane()
    thread = plane.thread("create", graph_id="bridge_journal")
    todos = [
        {"content": "inspect failure", "status": "completed"},
        {"content": "apply fix", "status": "in_progress"},
    ]

    written = plane.thread(
        "todos_write",
        thread_id=thread["thread_id"],
        todos=todos,
    )
    reread = plane.thread("todos_read", thread_id=thread["thread_id"])

    assert written["todos"] == todos
    assert reread["todos"] == todos
    assert reread["native_schema"].endswith("WriteTodosInput")


def test_native_todo_schema_rejects_invalid_status() -> None:
    plane = make_plane()
    thread = plane.thread("create", graph_id="bridge_journal")

    with pytest.raises(BridgeError, match="WriteTodosInput"):
        plane.thread(
            "todos_write",
            thread_id=thread["thread_id"],
            todos=[{"content": "invalid", "status": "blocked"}],
        )


def test_native_run_command_projects_hitl_resume_without_local_replay() -> None:
    plane = make_plane()
    thread = plane.thread("create", graph_id="bridge_journal")
    command = {"resume": {"decisions": [{"type": "approve"}]}}

    resumed = plane.run(
        "resume",
        thread_id=thread["thread_id"],
        assistant_id="bridge_journal",
        run_command=command,
        checkpoint_id="checkpoint-1",
        durability="sync",
    )

    assert resumed["command"] == command
    assert resumed["checkpoint_id"] == "checkpoint-1"
    assert resumed["durability"] == "sync"
    assert resumed["stream_resumable"] is True


def test_run_input_and_command_are_mutually_exclusive() -> None:
    plane = make_plane()
    thread = plane.thread("create", graph_id="bridge_journal")

    with pytest.raises(BridgeError, match="mutually exclusive"):
        plane.run(
            "create",
            thread_id=thread["thread_id"],
            assistant_id="bridge_journal",
            run_input={"events": []},
            run_command={"resume": "value"},
        )


def test_specialist_can_resume_native_interrupted_run() -> None:
    plane = make_plane()
    started = plane.specialist(
        "start",
        specialist="research",
        task={"question": "inspect"},
    )
    command = {"resume": {"decisions": [{"type": "reject"}]}}

    resumed = plane.specialist(
        "resume",
        specialist="research",
        thread_id=started["thread_id"],
        run_command=command,
    )

    assert resumed["run"]["command"] == command


def test_runtime_rejects_thread_outside_metadata_boundary() -> None:
    client = FakeClient()
    client.threads.values["foreign"] = {
        "thread_id": "foreign",
        "metadata": {"other_owner": "value"},
    }
    plane = AgentServerPlane(
        AgentServerPlaneConfig(
            url="http://agent-server.test",
            allowed_assistant_ids=("bridge_journal",),
            thread_metadata_key="bridge_owner",
            thread_metadata_value="test",
        ),
        client_factory=lambda **_: client,
    )

    with pytest.raises(BridgeError, match="metadata boundary"):
        plane.thread("get", thread_id="foreign")

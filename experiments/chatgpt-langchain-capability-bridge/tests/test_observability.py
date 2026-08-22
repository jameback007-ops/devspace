from __future__ import annotations

import pytest

from chatgpt_langchain_bridge.observability import ObservabilityPlane


class EnterFailure:
    def __enter__(self):
        raise RuntimeError("trace unavailable")

    def __exit__(self, *_):
        return None


class ExitFailure:
    def __enter__(self):
        return object()

    def __exit__(self, *_):
        raise RuntimeError("trace flush unavailable")


class RecordingManager:
    def __enter__(self):
        return object()

    def __exit__(self, *_):
        return None


def test_tracing_failure_is_fail_open(monkeypatch) -> None:
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "bound-but-never-printed")
    plane = ObservabilityPlane(trace_factory=lambda *_, **__: EnterFailure())

    @plane.instrument("test")
    def tool(value: int) -> int:
        return value + 1

    assert tool(2) == 3
    status = plane.status()
    assert status["trace_error_count"] == 1
    assert status["last_trace_error_type"] == "RuntimeError"


def test_trace_teardown_failure_does_not_change_tool_result(monkeypatch) -> None:
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "bound-but-never-printed")
    plane = ObservabilityPlane(trace_factory=lambda *_, **__: ExitFailure())

    @plane.instrument("test")
    def tool() -> str:
        return "terminal"

    assert tool() == "terminal"
    assert plane.status()["trace_error_count"] == 1


def test_tool_failure_remains_authoritative_when_trace_teardown_fails(
    monkeypatch,
) -> None:
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "bound-but-never-printed")
    plane = ObservabilityPlane(trace_factory=lambda *_, **__: ExitFailure())

    @plane.instrument("test")
    def tool() -> None:
        raise ValueError("tool failure")

    with pytest.raises(ValueError, match="tool failure"):
        tool()
    assert plane.status()["trace_error_count"] == 1


@pytest.mark.asyncio
async def test_async_tool_trace_wraps_awaited_execution(monkeypatch) -> None:
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "bound-but-never-printed")
    events: list[str] = []

    class AsyncTrace:
        def __enter__(self):
            events.append("enter")
            return self

        def __exit__(self, *_):
            events.append("exit")
            return None

    plane = ObservabilityPlane(trace_factory=lambda *_, **__: AsyncTrace())

    @plane.instrument("async-test")
    async def tool() -> str:
        events.append("tool")
        return "terminal"

    assert await tool() == "terminal"
    assert events == ["enter", "tool", "exit"]


def test_observability_groups_tools_by_workstream_thread_metadata(monkeypatch) -> None:
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "bound-but-never-printed")
    calls: list[dict] = []

    def factory(*args, **kwargs):
        calls.append({"args": args, "kwargs": kwargs})
        return RecordingManager()

    plane = ObservabilityPlane(trace_factory=factory)
    plane.set_context_resolver(
        lambda tool_name, arguments: {
            "thread_id": "workstream-1",
            "workstream_ref": "workstream-1",
            "workspace_id": arguments.get("workspace_id"),
            "bridge_reasoning_owner": "chatgpt_webchat",
        }
    )

    @plane.instrument("read_file")
    def tool(workspace_id: str, file_path: str) -> str:
        return file_path

    assert tool("ws_1", "secret-source.py") == "secret-source.py"
    metadata = calls[0]["kwargs"]["metadata"]
    inputs = calls[0]["kwargs"]["inputs"]
    assert metadata["thread_id"] == "workstream-1"
    assert metadata["workstream_ref"] == "workstream-1"
    assert metadata["workspace_id"] == "ws_1"
    assert "langsmith-thread-bound" in calls[0]["kwargs"]["tags"]
    assert inputs == {
        "positional_argument_count": 2,
        "keyword_argument_names": [],
    }
    assert "secret-source.py" not in str(inputs)

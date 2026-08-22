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

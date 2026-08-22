from __future__ import annotations

import functools
import os
from threading import RLock
from typing import Any, Callable, TypeVar, cast

from langsmith import trace

F = TypeVar("F", bound=Callable[..., Any])


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().casefold() in {"1", "true", "yes", "on"}


class ObservabilityPlane:
    """Credential-safe LangSmith tracing for MCP tool lifecycle metadata."""

    def __init__(self, trace_factory: Callable[..., Any] = trace) -> None:
        self._enabled = _env_bool("LANGSMITH_TRACING") and bool(
            os.environ.get("LANGSMITH_API_KEY")
        )
        self._project = os.environ.get(
            "LANGSMITH_PROJECT", "zes-chatgpt-langchain-capability-bridge"
        )
        self._trace_factory = trace_factory
        self._trace_error_count = 0
        self._last_trace_error_type: str | None = None
        self._lock = RLock()

    def status(self) -> dict[str, Any]:
        return {
            "schema_version": "chatgpt-langchain-observability.v1",
            "state": "enabled" if self._enabled else "disabled",
            "langsmith_key_present": bool(os.environ.get("LANGSMITH_API_KEY")),
            "endpoint": os.environ.get("LANGSMITH_ENDPOINT"),
            "project": self._project,
            "payload_policy": "tool name and argument names only; values and outputs excluded",
            "webchat_hidden_reasoning_captured": False,
            "fail_open": True,
            "trace_error_count": self._trace_error_count,
            "last_trace_error_type": self._last_trace_error_type,
        }

    def instrument(self, tool_name: str) -> Callable[[F], F]:
        def decorate(func: F) -> F:
            @functools.wraps(func)
            def wrapped(*args: Any, **kwargs: Any) -> Any:
                if not self._enabled:
                    return func(*args, **kwargs)

                try:
                    manager = self._trace_factory(
                        f"mcp.{tool_name}",
                        run_type="tool",
                        inputs={
                            "positional_argument_count": len(args),
                            "keyword_argument_names": sorted(kwargs),
                        },
                        project_name=self._project,
                        tags=["chatgpt-owned-coding-loop", "mcp-capability-plane"],
                        metadata={
                            "tool_name": tool_name,
                            "payload_values_recorded": False,
                        },
                    )
                    manager.__enter__()
                except Exception as exc:
                    self._record_trace_error(exc)
                    return func(*args, **kwargs)

                try:
                    result = func(*args, **kwargs)
                except BaseException as exc:
                    try:
                        manager.__exit__(type(exc), exc, exc.__traceback__)
                    except Exception as trace_exc:
                        self._record_trace_error(trace_exc)
                    raise
                try:
                    manager.__exit__(None, None, None)
                except Exception as exc:
                    self._record_trace_error(exc)
                return result

            return cast(F, wrapped)

        return decorate

    def _record_trace_error(self, exc: Exception) -> None:
        with self._lock:
            self._trace_error_count += 1
            self._last_trace_error_type = type(exc).__name__

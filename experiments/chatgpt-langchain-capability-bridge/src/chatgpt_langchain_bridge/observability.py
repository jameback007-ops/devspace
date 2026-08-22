from __future__ import annotations

import functools
import inspect
import os
from threading import RLock
from typing import Any, Callable, Mapping, TypeVar, cast

from langsmith import trace

F = TypeVar("F", bound=Callable[..., Any])
TraceContextResolver = Callable[[str, Mapping[str, Any]], dict[str, Any]]


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
        self._context_resolver: TraceContextResolver | None = None
        self._lock = RLock()

    def set_context_resolver(self, resolver: TraceContextResolver) -> None:
        self._context_resolver = resolver

    def status(self) -> dict[str, Any]:
        return {
            "schema_version": "chatgpt-langchain-observability.v1",
            "state": "enabled" if self._enabled else "disabled",
            "langsmith_key_present": bool(os.environ.get("LANGSMITH_API_KEY")),
            "endpoint": os.environ.get("LANGSMITH_ENDPOINT"),
            "project": self._project,
            "payload_policy": "tool name and argument names only; values and outputs excluded",
            "thread_grouping": {
                "metadata_key": "thread_id",
                "source": "workspace workstream binding",
                "langsmith_threads_native": True,
            },
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

                call_arguments = self._bind_arguments(func, args, kwargs)
                trace_context = self._resolve_context(tool_name, call_arguments)
                metadata = {
                    "tool_name": tool_name,
                    "payload_values_recorded": False,
                    **trace_context,
                }
                tags = ["chatgpt-owned-coding-loop", "mcp-capability-plane"]
                if trace_context.get("thread_id"):
                    tags.append("langsmith-thread-bound")

                try:
                    manager = self._trace_factory(
                        f"mcp.{tool_name}",
                        run_type="tool",
                        inputs={
                            "positional_argument_count": len(args),
                            "keyword_argument_names": sorted(kwargs),
                        },
                        project_name=self._project,
                        tags=tags,
                        metadata=metadata,
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

    @staticmethod
    def _bind_arguments(
        func: Callable[..., Any], args: tuple[Any, ...], kwargs: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            bound = inspect.signature(func).bind_partial(*args, **kwargs)
        except (TypeError, ValueError):
            return dict(kwargs)
        return dict(bound.arguments)

    def _resolve_context(
        self, tool_name: str, arguments: Mapping[str, Any]
    ) -> dict[str, Any]:
        if self._context_resolver is None:
            return {}
        try:
            raw = self._context_resolver(tool_name, arguments)
        except Exception as exc:
            self._record_trace_error(exc)
            return {}
        allowed = {
            "thread_id",
            "workstream_ref",
            "agent_server_thread_id",
            "workspace_id",
            "bridge_reasoning_owner",
        }
        return {
            key: value
            for key, value in raw.items()
            if key in allowed and value is not None
        }

    def _record_trace_error(self, exc: Exception) -> None:
        with self._lock:
            self._trace_error_count += 1
            self._last_trace_error_type = type(exc).__name__

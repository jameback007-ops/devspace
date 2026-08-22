from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Callable

from langchain.agents.middleware.todo import WriteTodosInput
from langgraph_sdk import get_sync_client
from pydantic import ValidationError

from .registry import BridgeError
from .serialization import json_safe


@dataclass(frozen=True)
class AgentServerPlaneConfig:
    url: str | None = None
    allowed_assistant_ids: tuple[str, ...] = ()
    specialist_assistants: tuple[tuple[str, str], ...] = ()
    store_namespace_prefix: tuple[str, ...] = ("chatgpt-langchain-bridge",)
    thread_metadata_key: str = "chatgpt_langchain_bridge"
    thread_metadata_value: str = "v2"
    workstream_metadata_key: str = "bridge_workstream_ref"
    workstream_graph_id: str = "bridge_journal"
    max_stream_events: int = 100
    request_timeout_seconds: float = 60.0

    @classmethod
    def from_environment(cls) -> AgentServerPlaneConfig:
        url = os.environ.get("BRIDGE_AGENT_SERVER_URL", "").strip() or None
        if url is None and os.environ.get(
            "BRIDGE_AGENT_SERVER_SELF", ""
        ).strip().casefold() in {
            "1",
            "true",
            "yes",
            "on",
        }:
            url = f"http://127.0.0.1:{os.environ.get('PORT', '8000')}"
        raw_specialists = os.environ.get("BRIDGE_SPECIALIST_ASSISTANTS", "{}").strip()
        try:
            parsed = json.loads(raw_specialists)
        except json.JSONDecodeError as exc:
            raise BridgeError(
                "BRIDGE_SPECIALIST_ASSISTANTS must be valid JSON"
            ) from exc
        if not isinstance(parsed, dict) or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in parsed.items()
        ):
            raise BridgeError(
                "BRIDGE_SPECIALIST_ASSISTANTS must be a JSON object of alias to assistant_id"
            )

        allowed_assistants = tuple(
            item.strip()
            for item in os.environ.get(
                "BRIDGE_AGENT_SERVER_ASSISTANT_IDS", "bridge_journal,bridge_hitl"
            ).split(",")
            if item.strip()
        )
        namespace_prefix = tuple(
            item.strip()
            for item in os.environ.get(
                "BRIDGE_AGENT_SERVER_STORE_PREFIX", "chatgpt-langchain-bridge"
            ).split("/")
            if item.strip()
        )
        if not namespace_prefix:
            raise BridgeError("BRIDGE_AGENT_SERVER_STORE_PREFIX cannot be empty")
        return cls(
            url=url,
            allowed_assistant_ids=allowed_assistants,
            specialist_assistants=tuple(sorted(parsed.items())),
            store_namespace_prefix=namespace_prefix,
            thread_metadata_key=os.environ.get(
                "BRIDGE_AGENT_SERVER_THREAD_METADATA_KEY",
                "chatgpt_langchain_bridge",
            ),
            thread_metadata_value=os.environ.get(
                "BRIDGE_AGENT_SERVER_THREAD_METADATA_VALUE",
                "v2",
            ),
            workstream_metadata_key=os.environ.get(
                "BRIDGE_AGENT_SERVER_WORKSTREAM_METADATA_KEY",
                "bridge_workstream_ref",
            ),
            workstream_graph_id=os.environ.get(
                "BRIDGE_AGENT_SERVER_WORKSTREAM_GRAPH_ID",
                "bridge_journal",
            ),
            max_stream_events=int(
                os.environ.get("BRIDGE_MAX_AGENT_SERVER_STREAM_EVENTS", "100")
            ),
            request_timeout_seconds=max(
                1.0,
                min(
                    float(
                        os.environ.get(
                            "BRIDGE_AGENT_SERVER_REQUEST_TIMEOUT_SECONDS", "60"
                        )
                    ),
                    120.0,
                ),
            ),
        )


class AgentServerPlane:
    """Typed WebChat projection over native LangGraph Agent Server clients."""

    def __init__(
        self,
        config: AgentServerPlaneConfig | None = None,
        client_factory: Callable[..., Any] = get_sync_client,
    ) -> None:
        self._config = config or AgentServerPlaneConfig.from_environment()
        self._client_factory = client_factory
        self._client_instance: Any | None = None
        self._specialists = dict(self._config.specialist_assistants)

    def manifest(self) -> dict[str, Any]:
        return {
            "state": "available" if self._config.url else "disabled",
            "url_configured": bool(self._config.url),
            "native_components": [
                "langgraph_sdk.threads",
                "langgraph_sdk.runs",
                "langgraph_sdk.store",
                "langgraph_sdk.assistants",
            ],
            "features": [
                "threads",
                "checkpoints_and_history",
                "durable_runs",
                "run_cancel_and_join",
                "resumable_run_stream",
                "native_interrupt_resume_command",
                "native_todo_state",
                "store",
                "optional_allowlisted_specialists",
            ],
            "specialist_aliases": sorted(self._specialists),
            "allowed_assistant_ids": list(self._config.allowed_assistant_ids),
            "store_namespace_prefix": list(self._config.store_namespace_prefix),
            "thread_metadata_boundary": {
                "key": self._config.thread_metadata_key,
                "value": self._config.thread_metadata_value,
            },
            "workstream_binding": {
                "metadata_key": self._config.workstream_metadata_key,
                "graph_id": self._config.workstream_graph_id,
                "resolver": "threads.search_then_create",
            },
            "dedicated_agent_server_required": True,
            "request_timeout_seconds": self._config.request_timeout_seconds,
            "native_planning_schema": "langchain.agents.middleware.todo.WriteTodosInput",
            "native_hitl_schema": "langchain.agents.middleware.human_in_the_loop.HITLResponse",
            "reasoning_owner": "chatgpt_webchat",
        }

    def bind_workstream(self, workstream_ref: str) -> dict[str, Any]:
        """Resolve or create one native Agent Server thread by metadata.

        The user-facing workstream reference remains an adapter identity. The
        native Agent Server owns thread status, timestamps, checkpoints, runs,
        and Studio inspection. No parallel activity database is created.
        """

        client = self._client()
        metadata = self._owned_metadata(
            {
                self._config.workstream_metadata_key: workstream_ref,
                "bridge_reasoning_owner": "chatgpt_webchat",
            }
        )
        matches = client.threads.search(
            metadata=metadata,
            limit=2,
            sort_by="updated_at",
            sort_order="desc",
        )
        if len(matches) > 1:
            raise BridgeError(
                "multiple Agent Server threads match one bridge workstream_ref"
            )
        if matches:
            thread = matches[0]
            state = "resolved_existing_agent_thread"
        else:
            self._require_assistant(self._config.workstream_graph_id)
            thread = client.threads.create(
                graph_id=self._config.workstream_graph_id,
                metadata=metadata,
            )
            state = "created_agent_thread"

        public = json_safe(thread)
        return {
            "state": state,
            "workstream_ref": workstream_ref,
            "thread_id": public["thread_id"],
            "status": public.get("status"),
            "created_at": public.get("created_at"),
            "updated_at": public.get("updated_at"),
            "metadata": public.get("metadata", {}),
            "native_source": "langgraph_sdk.threads",
        }

    def thread(
        self,
        action: str,
        *,
        thread_id: str = "",
        graph_id: str = "",
        metadata: dict[str, Any] | None = None,
        values: dict[str, Any] | list[dict[str, Any]] | None = None,
        todos: list[dict[str, Any]] | None = None,
        limit: int = 10,
    ) -> dict[str, Any]:
        client = self._client()
        bounded_limit = max(1, min(limit, 100))
        if action == "create":
            if graph_id:
                self._require_assistant(graph_id)
            return json_safe(
                client.threads.create(
                    graph_id=graph_id or None,
                    metadata=self._owned_metadata(metadata),
                )
            )
        if action == "get":
            self._require(thread_id, "thread_id")
            return json_safe(self._require_owned_thread(client, thread_id))
        if action == "state":
            self._require(thread_id, "thread_id")
            self._require_owned_thread(client, thread_id)
            return json_safe(client.threads.get_state(thread_id))
        if action == "history":
            self._require(thread_id, "thread_id")
            self._require_owned_thread(client, thread_id)
            return {
                "history": json_safe(
                    client.threads.get_history(thread_id, limit=bounded_limit)
                )
            }
        if action == "search":
            return {
                "threads": json_safe(
                    client.threads.search(
                        metadata=self._owned_metadata(metadata),
                        limit=bounded_limit,
                    )
                )
            }
        if action == "update_state":
            self._require(thread_id, "thread_id")
            self._require_owned_thread(client, thread_id)
            return json_safe(client.threads.update_state(thread_id, values))
        if action == "todos_read":
            self._require(thread_id, "thread_id")
            self._require_owned_thread(client, thread_id)
            state = json_safe(client.threads.get_state(thread_id))
            values_payload = state.get("values", {}) if isinstance(state, dict) else {}
            return {
                "thread_id": thread_id,
                "todos": values_payload.get("todos", []),
                "native_schema": "langchain.agents.middleware.todo.WriteTodosInput",
                "state": state,
            }
        if action == "todos_write":
            self._require(thread_id, "thread_id")
            self._require_owned_thread(client, thread_id)
            try:
                validated = WriteTodosInput.model_validate({"todos": todos or []})
            except ValidationError as exc:
                raise BridgeError(
                    "todos do not match native WriteTodosInput schema"
                ) from exc
            native_todos = validated.model_dump(mode="json")["todos"]
            update = client.threads.update_state(thread_id, {"todos": native_todos})
            return {
                "thread_id": thread_id,
                "todos": native_todos,
                "native_schema": "langchain.agents.middleware.todo.WriteTodosInput",
                "update": json_safe(update),
            }
        if action == "delete":
            self._require(thread_id, "thread_id")
            self._require_owned_thread(client, thread_id)
            client.threads.delete(thread_id)
            return {"thread_id": thread_id, "deleted": True}
        raise BridgeError(
            "runtime_thread action must be create, get, state, history, search, update_state, todos_read, todos_write, or delete"
        )

    def run(
        self,
        action: str,
        *,
        thread_id: str = "",
        assistant_id: str = "",
        run_id: str = "",
        run_input: dict[str, Any] | list[Any] | str | None = None,
        run_command: dict[str, Any] | None = None,
        checkpoint_id: str = "",
        interrupt_before: list[str] | None = None,
        interrupt_after: list[str] | None = None,
        durability: str = "",
        limit: int = 20,
        stream_mode: str = "values",
    ) -> dict[str, Any]:
        client = self._client()
        bounded_limit = max(1, min(limit, self._config.max_stream_events))
        if action in {"create", "resume"}:
            self._require_assistant(assistant_id)
            self._require(thread_id, "thread_id")
            self._require_owned_thread(client, thread_id)
            if action == "resume" and run_command is None:
                raise BridgeError("run_command is required for runtime_run resume")
            return json_safe(
                client.runs.create(
                    thread_id,
                    assistant_id,
                    **self._run_payload(
                        run_input=run_input,
                        run_command=run_command,
                        checkpoint_id=checkpoint_id,
                        interrupt_before=interrupt_before,
                        interrupt_after=interrupt_after,
                        durability=durability,
                    ),
                    stream_mode=stream_mode,
                    stream_resumable=True,
                )
            )
        if action == "invoke":
            self._require_assistant(assistant_id)
            self._require(thread_id, "thread_id")
            self._require_owned_thread(client, thread_id)
            return {
                "result": json_safe(
                    client.runs.wait(
                        thread_id,
                        assistant_id,
                        **self._run_payload(
                            run_input=run_input,
                            run_command=run_command,
                            checkpoint_id=checkpoint_id,
                            interrupt_before=interrupt_before,
                            interrupt_after=interrupt_after,
                            durability=durability,
                        ),
                    )
                )
            }
        if action == "get":
            self._require(thread_id, "thread_id")
            self._require(run_id, "run_id")
            self._require_owned_thread(client, thread_id)
            return json_safe(client.runs.get(thread_id, run_id))
        if action == "join":
            self._require(thread_id, "thread_id")
            self._require(run_id, "run_id")
            self._require_owned_thread(client, thread_id)
            return {"result": json_safe(client.runs.join(thread_id, run_id))}
        if action == "list":
            self._require(thread_id, "thread_id")
            self._require_owned_thread(client, thread_id)
            return {"runs": json_safe(client.runs.list(thread_id, limit=bounded_limit))}
        if action == "events":
            self._require(thread_id, "thread_id")
            self._require(run_id, "run_id")
            self._require_owned_thread(client, thread_id)
            events = []
            for event in client.runs.join_stream(
                thread_id,
                run_id,
                stream_mode=stream_mode,
            ):
                events.append(json_safe(event))
                if len(events) >= bounded_limit:
                    break
            return {
                "events": events,
                "bounded_limit": bounded_limit,
                "may_have_more": len(events) == bounded_limit,
            }
        if action == "cancel":
            self._require(thread_id, "thread_id")
            self._require(run_id, "run_id")
            self._require_owned_thread(client, thread_id)
            client.runs.cancel(thread_id, run_id, wait=False, action="interrupt")
            return {"thread_id": thread_id, "run_id": run_id, "cancel_requested": True}
        raise BridgeError(
            "runtime_run action must be create, resume, invoke, get, join, list, events, or cancel"
        )

    def store(
        self,
        action: str,
        *,
        namespace: list[str] | None = None,
        key: str = "",
        value: dict[str, Any] | None = None,
        query: str = "",
        limit: int = 10,
    ) -> dict[str, Any]:
        client = self._client()
        namespace = namespace or []
        effective_namespace = [*self._config.store_namespace_prefix, *namespace]
        bounded_limit = max(1, min(limit, 100))
        if action == "put":
            self._require_namespace(namespace)
            self._require(key, "key")
            if value is None:
                raise BridgeError("value is required for runtime_store put")
            client.store.put_item(effective_namespace, key, value)
            return {
                "namespace": namespace,
                "namespace_prefix": list(self._config.store_namespace_prefix),
                "key": key,
                "stored": True,
            }
        if action == "get":
            self._require_namespace(namespace)
            self._require(key, "key")
            return json_safe(client.store.get_item(effective_namespace, key))
        if action == "search":
            self._require_namespace(namespace)
            return json_safe(
                client.store.search_items(
                    effective_namespace,
                    query=query or None,
                    limit=bounded_limit,
                )
            )
        if action == "delete":
            self._require_namespace(namespace)
            self._require(key, "key")
            client.store.delete_item(effective_namespace, key)
            return {
                "namespace": namespace,
                "namespace_prefix": list(self._config.store_namespace_prefix),
                "key": key,
                "deleted": True,
            }
        if action == "list_namespaces":
            return json_safe(
                client.store.list_namespaces(
                    prefix=effective_namespace,
                    limit=bounded_limit,
                )
            )
        raise BridgeError(
            "runtime_store action must be put, get, search, delete, or list_namespaces"
        )

    def specialist(
        self,
        action: str,
        *,
        specialist: str = "",
        thread_id: str = "",
        run_id: str = "",
        task: dict[str, Any] | list[Any] | str | None = None,
        run_command: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if action == "list":
            return {
                "specialists": [
                    {"alias": alias, "available": True}
                    for alias in sorted(self._specialists)
                ],
                "reasoning_owner": "chatgpt_webchat",
                "default_delegation": False,
            }

        assistant_id = self._specialists.get(specialist)
        if assistant_id is None:
            raise BridgeError("specialist alias is not configured")
        client = self._client()
        if action == "start":
            if not thread_id:
                created = client.threads.create(
                    metadata=self._owned_metadata({"bridge_specialist": specialist})
                )
                thread_id = str(created["thread_id"])
            else:
                self._require_owned_thread(client, thread_id)
            run = client.runs.create(
                thread_id,
                assistant_id,
                input=task,
                stream_resumable=True,
                metadata=self._owned_metadata({"bridge_specialist": specialist}),
            )
            return {
                "specialist": specialist,
                "thread_id": thread_id,
                "run": json_safe(run),
            }
        if action == "resume":
            self._require(thread_id, "thread_id")
            self._require_owned_thread(client, thread_id)
            if run_command is None:
                raise BridgeError("run_command is required for specialist_task resume")
            run = client.runs.create(
                thread_id,
                assistant_id,
                command=run_command,
                stream_resumable=True,
                metadata=self._owned_metadata({"bridge_specialist": specialist}),
            )
            return {
                "specialist": specialist,
                "thread_id": thread_id,
                "run": json_safe(run),
            }
        if action == "status":
            self._require(thread_id, "thread_id")
            self._require(run_id, "run_id")
            self._require_owned_thread(client, thread_id)
            return {
                "specialist": specialist,
                "run": json_safe(client.runs.get(thread_id, run_id)),
            }
        if action == "result":
            self._require(thread_id, "thread_id")
            self._require(run_id, "run_id")
            self._require_owned_thread(client, thread_id)
            return {
                "specialist": specialist,
                "result": json_safe(client.runs.join(thread_id, run_id)),
            }
        if action == "cancel":
            self._require(thread_id, "thread_id")
            self._require(run_id, "run_id")
            self._require_owned_thread(client, thread_id)
            client.runs.cancel(thread_id, run_id, wait=False, action="interrupt")
            return {
                "specialist": specialist,
                "thread_id": thread_id,
                "run_id": run_id,
                "cancel_requested": True,
            }
        raise BridgeError(
            "specialist_task action must be list, start, resume, status, result, or cancel"
        )

    def _client(self) -> Any:
        if not self._config.url:
            raise BridgeError("Agent Server URL is not configured")
        if self._client_instance is None:
            try:
                self._client_instance = self._client_factory(
                    url=self._config.url,
                    timeout=self._config.request_timeout_seconds,
                )
            except Exception as exc:
                raise BridgeError(
                    f"Agent Server client initialization failed: {type(exc).__name__}"
                ) from exc
        return self._client_instance

    @staticmethod
    def _require(value: str, name: str) -> None:
        if not value:
            raise BridgeError(f"{name} is required")

    def _require_assistant(self, assistant_id: str) -> None:
        self._require(assistant_id, "assistant_id")
        if assistant_id not in self._config.allowed_assistant_ids:
            raise BridgeError("assistant_id is outside the configured allowlist")

    def _owned_metadata(self, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        return {
            **(metadata or {}),
            self._config.thread_metadata_key: self._config.thread_metadata_value,
        }

    def _require_owned_thread(self, client: Any, thread_id: str) -> Any:
        thread = client.threads.get(thread_id)
        metadata = (
            thread.get("metadata", {})
            if isinstance(thread, dict)
            else getattr(thread, "metadata", {})
        )
        if (
            not isinstance(metadata, dict)
            or metadata.get(self._config.thread_metadata_key)
            != self._config.thread_metadata_value
        ):
            raise BridgeError("thread_id is outside the bridge metadata boundary")
        return thread

    @staticmethod
    def _run_payload(
        *,
        run_input: dict[str, Any] | list[Any] | str | None,
        run_command: dict[str, Any] | None,
        checkpoint_id: str,
        interrupt_before: list[str] | None,
        interrupt_after: list[str] | None,
        durability: str,
    ) -> dict[str, Any]:
        if run_input is not None and run_command is not None:
            raise BridgeError("run_input and run_command are mutually exclusive")
        payload: dict[str, Any] = {}
        if run_command is not None:
            payload["command"] = run_command
        else:
            payload["input"] = run_input
        if checkpoint_id:
            payload["checkpoint_id"] = checkpoint_id
        if interrupt_before:
            payload["interrupt_before"] = interrupt_before
        if interrupt_after:
            payload["interrupt_after"] = interrupt_after
        if durability:
            if durability not in {"exit", "async", "sync"}:
                raise BridgeError("durability must be exit, async, or sync")
            payload["durability"] = durability
        return payload

    @staticmethod
    def _require_namespace(namespace: list[str]) -> None:
        if not namespace or not all(
            isinstance(item, str) and item for item in namespace
        ):
            raise BridgeError("namespace must contain at least one non-empty string")

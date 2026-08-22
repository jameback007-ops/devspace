from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from langsmith import uuid7

from .agent_server_plane import AgentServerPlane
from .registry import BridgeError


_WORKSTREAM_REF_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")


@dataclass(frozen=True)
class WorkstreamBinding:
    """Thin WebChat-to-native-thread binding with no independent state engine."""

    workstream_ref: str
    trace_thread_id: str
    source: str
    state: str
    bound_at: str
    agent_thread_id: str | None = None
    agent_thread_status: str | None = None
    agent_thread_updated_at: str | None = None
    interaction_thread_id: str | None = None
    interaction_thread_status: str | None = None
    interaction_thread_updated_at: str | None = None
    provider_error_type: str | None = None

    def public_view(self) -> dict[str, Any]:
        return {
            "workstream_ref": self.workstream_ref,
            "trace_thread_id": self.trace_thread_id,
            "source": self.source,
            "state": self.state,
            "bound_at": self.bound_at,
            "agent_thread_id": self.agent_thread_id,
            "agent_thread_status": self.agent_thread_status,
            "agent_thread_updated_at": self.agent_thread_updated_at,
            "interaction_thread_id": self.interaction_thread_id,
            "interaction_thread_status": self.interaction_thread_status,
            "interaction_thread_updated_at": self.interaction_thread_updated_at,
            "provider_error_type": self.provider_error_type,
            "authority": {
                "workstream_identity": "webchat_supplied_or_bridge_minted_ref",
                "runtime_state": "langgraph_agent_server_thread_when_available",
                "interaction_state": "langgraph_agent_server_a2a_thread_when_available",
                "trace_grouping": "langsmith_thread_metadata",
                "custom_activity_store_created": False,
            },
        }


class WorkstreamBindingPlane:
    """Resolve one WebChat workstream into native Agent Server and LangSmith IDs."""

    def __init__(self, agent_server: AgentServerPlane) -> None:
        self._agent_server = agent_server

    def manifest(self) -> dict[str, Any]:
        agent_manifest = self._agent_server.manifest()
        return {
            "state": (
                "available"
                if agent_manifest["state"] == "available"
                else "local_trace_only"
            ),
            "native_components": [
                "langgraph_sdk.threads.search/create/get",
                "langsmith trace metadata thread_id",
            ],
            "binding_seam": "workspace_open.thread_id -> workstream_ref",
            "mint_when_missing": "langsmith.uuid7",
            "agent_server_state": agent_manifest["state"],
            "custom_database": False,
            "custom_dashboard": False,
            "hidden_webchat_conversation_id_required": False,
        }

    def bind(self, raw_workstream_ref: str) -> WorkstreamBinding:
        workstream_ref, source = self._normalize_or_mint(raw_workstream_ref)
        bound_at = datetime.now(UTC).isoformat()
        try:
            native = self._agent_server.bind_workstream(workstream_ref)
        except Exception as exc:
            return WorkstreamBinding(
                workstream_ref=workstream_ref,
                trace_thread_id=workstream_ref,
                source=source,
                state="degraded_local_trace_only",
                bound_at=bound_at,
                provider_error_type=type(exc).__name__,
            )

        return WorkstreamBinding(
            workstream_ref=workstream_ref,
            trace_thread_id=workstream_ref,
            source=source,
            state=str(native["state"]),
            bound_at=bound_at,
            agent_thread_id=native.get("thread_id"),
            agent_thread_status=native.get("status"),
            agent_thread_updated_at=native.get("updated_at"),
            interaction_thread_id=native.get("interaction_thread_id"),
            interaction_thread_status=native.get("interaction_thread_status"),
            interaction_thread_updated_at=native.get("interaction_thread_updated_at"),
        )

    @staticmethod
    def _normalize_or_mint(raw: str) -> tuple[str, str]:
        value = raw.strip()
        if not value:
            return str(uuid7()), "bridge_minted_uuid7"
        if not _WORKSTREAM_REF_PATTERN.fullmatch(value):
            raise BridgeError(
                "thread_id/workstream_ref must match [A-Za-z0-9][A-Za-z0-9._:/-]{0,255}"
            )
        return value, "webchat_supplied"

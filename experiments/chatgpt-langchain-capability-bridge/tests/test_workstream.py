from __future__ import annotations

from typing import Any

import pytest

from chatgpt_langchain_bridge.registry import BridgeError
from chatgpt_langchain_bridge.workstream import WorkstreamBindingPlane


class FakeAgentServer:
    def __init__(self, *, available: bool = True) -> None:
        self.available = available

    def manifest(self) -> dict[str, Any]:
        return {"state": "available" if self.available else "disabled"}

    def bind_workstream(self, workstream_ref: str) -> dict[str, Any]:
        if not self.available:
            raise BridgeError("Agent Server URL is not configured")
        return {
            "state": "created_agent_thread",
            "thread_id": "0198f8ab-1234-7000-8000-000000000001",
            "status": "idle",
            "updated_at": "2026-08-22T00:00:00+00:00",
            "interaction_thread_id": "0198f8ab-1234-7000-8000-000000000002",
            "interaction_thread_status": "idle",
            "interaction_thread_updated_at": "2026-08-22T00:00:01+00:00",
        }


def test_explicit_workstream_binds_native_thread() -> None:
    binding = WorkstreamBindingPlane(FakeAgentServer()).bind("mission/alpha")

    assert binding.workstream_ref == "mission/alpha"
    assert binding.trace_thread_id == "mission/alpha"
    assert binding.source == "webchat_supplied"
    assert binding.state == "created_agent_thread"
    assert binding.agent_thread_status == "idle"
    assert binding.interaction_thread_id
    assert binding.interaction_thread_status == "idle"


def test_missing_workstream_mints_uuid7_ref() -> None:
    binding = WorkstreamBindingPlane(FakeAgentServer()).bind("")

    assert binding.source == "bridge_minted_uuid7"
    assert binding.trace_thread_id == binding.workstream_ref
    assert len(binding.workstream_ref) == 36


def test_agent_server_failure_degrades_without_blocking_coding() -> None:
    binding = WorkstreamBindingPlane(FakeAgentServer(available=False)).bind(
        "mission/degraded"
    )

    assert binding.state == "degraded_local_trace_only"
    assert binding.agent_thread_id is None
    assert binding.provider_error_type == "BridgeError"


def test_invalid_workstream_ref_is_rejected() -> None:
    with pytest.raises(BridgeError, match="workstream_ref"):
        WorkstreamBindingPlane(FakeAgentServer()).bind("contains spaces")

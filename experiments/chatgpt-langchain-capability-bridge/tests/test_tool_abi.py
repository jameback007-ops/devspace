from __future__ import annotations

from pathlib import Path

import pytest

from chatgpt_langchain_bridge.registry import BridgeConfig, WorkspaceRegistry
from chatgpt_langchain_bridge.server import build_server
from chatgpt_langchain_bridge.state import CheckpointJournal
from chatgpt_langchain_bridge.tool_abi import (
    ABI_FINGERPRINT_SHA256,
    ABI_TOOL_NAMES,
    tool_fingerprint_sha256,
)


@pytest.mark.asyncio
async def test_model_facing_tool_abi_is_frozen(tmp_path: Path) -> None:
    registry = WorkspaceRegistry(BridgeConfig(allowed_roots=(tmp_path,)))
    journal = CheckpointJournal(tmp_path / "abi.sqlite")
    try:
        tools = await build_server(registry=registry, journal=journal).list_tools()
    finally:
        journal.close()

    assert tuple(sorted(tool.name for tool in tools)) == ABI_TOOL_NAMES
    assert tool_fingerprint_sha256(tools) == ABI_FINGERPRINT_SHA256

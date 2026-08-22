from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any

ABI_VERSION = "chatgpt-langchain-capability-bridge.tools.v2"
ABI_FINGERPRINT_SHA256 = (
    "071b7d38d9205565264541ecc3eb84b5fa3681544d462eaf3511abf90e6a47b7"
)
PREDECESSOR_ABI_VERSION = "chatgpt-langchain-capability-bridge.tools.v1"
PREDECESSOR_ABI_FINGERPRINT_SHA256 = (
    "8006cdd2a6c03e94b29fefbdab7f0dd1b9e1d7904e495d51c8e9f3ffab7b77e2"
)
ABI_TOOL_NAMES = (
    "artifact_transfer",
    "capability_manifest",
    "checkpoint_read",
    "checkpoint_record",
    "context_discover",
    "context_read",
    "delete_file",
    "edit_file",
    "execute",
    "glob",
    "grep",
    "ls",
    "observability_status",
    "process",
    "read_file",
    "runtime_run",
    "runtime_store",
    "runtime_thread",
    "sandbox_workspace",
    "specialist_task",
    "workspace_list",
    "workspace_open",
    "workspace_status",
    "write_file",
)


def canonical_tool_descriptors(tools: Iterable[Any]) -> list[dict[str, Any]]:
    descriptors: list[dict[str, Any]] = []
    for tool in tools:
        raw = tool.model_dump(mode="json", exclude_none=True)
        descriptors.append(
            {
                "name": raw.get("name"),
                "description": raw.get("description"),
                "input_schema": raw.get("input_schema"),
                "output_schema": raw.get("output_schema"),
                "annotations": raw.get("annotations"),
            }
        )
    return sorted(descriptors, key=lambda descriptor: descriptor["name"])


def tool_fingerprint_sha256(tools: Iterable[Any]) -> str:
    payload = json.dumps(
        canonical_tool_descriptors(tools),
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(payload).hexdigest()

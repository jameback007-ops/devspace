from __future__ import annotations

import argparse
import asyncio
import json
import time
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from chatgpt_langchain_bridge.tool_abi import (
    ABI_FINGERPRINT_SHA256,
    ABI_TOOL_NAMES,
    ABI_VERSION,
)


def structured(result: Any) -> Any:
    value = getattr(result, "structured_content", None)
    if value is not None:
        return value
    content = getattr(result, "content", None)
    if content and hasattr(content[0], "text"):
        return json.loads(content[0].text)
    raise RuntimeError(f"tool returned no structured content: {result!r}")


async def call(session: ClientSession, name: str, arguments: dict[str, Any]) -> Any:
    result = await session.call_tool(name, arguments)
    if result.is_error:
        raise RuntimeError(f"{name} failed: {result.content!r}")
    return structured(result)


async def qualify_once(
    url: str,
    workspace: str,
    thread_id: str,
) -> dict[str, Any]:
    async with (
        streamable_http_client(url) as streams,
        ClientSession(streams[0], streams[1]) as session,
    ):
        await session.initialize()
        tools = await session.list_tools()
        tool_names = tuple(sorted(tool.name for tool in tools.tools))
        if tool_names != ABI_TOOL_NAMES:
            raise AssertionError(f"tool ABI mismatch: {tool_names!r}")
        manifest = await call(session, "capability_manifest", {})
        if manifest["tool_abi"]["version"] != ABI_VERSION:
            raise AssertionError("tool ABI version mismatch")
        if manifest["tool_abi"]["fingerprint_sha256"] != ABI_FINGERPRINT_SHA256:
            raise AssertionError("tool ABI fingerprint mismatch")

        opened = await call(
            session,
            "workspace_open",
            {
                "path": workspace,
                "target_path": "src/coding_smoke/pricing.py",
                "thread_id": thread_id,
            },
        )
        workspace_id = opened["workspace_id"]
        bootstrap = opened["bootstrap"]
        if bootstrap["durable_state"]["state"] not in {"empty", "present"}:
            raise AssertionError("workspace bootstrap omitted durable-state pointer")

        source_before = await call(
            session,
            "read_file",
            {
                "workspace_id": workspace_id,
                "file_path": "src/coding_smoke/pricing.py",
            },
        )
        failing = await call(
            session,
            "execute",
            {
                "workspace_id": workspace_id,
                "command": "python3 -m pytest -q",
                "timeout": 120,
            },
        )
        if failing["exit_code"] == 0:
            raise AssertionError("fixture unexpectedly passed before repair")

        edited = await call(
            session,
            "edit_file",
            {
                "workspace_id": workspace_id,
                "file_path": "src/coding_smoke/pricing.py",
                "old_string": 'taxed = subtotal * tax_rate\n    return (taxed - discount).quantize(Decimal("0.01"))',
                "new_string": 'tax = subtotal * tax_rate\n    return (subtotal + tax - discount).quantize(Decimal("0.01"))',
            },
        )
        passing = await call(
            session,
            "execute",
            {
                "workspace_id": workspace_id,
                "command": "python3 -m pytest -q",
                "timeout": 120,
            },
        )
        if passing["exit_code"] != 0:
            raise AssertionError(
                f"fixture still fails after repair: {passing['output']}"
            )

        diff = await call(
            session,
            "execute",
            {
                "workspace_id": workspace_id,
                "command": "git diff --check && git diff -- src/coding_smoke/pricing.py",
            },
        )
        checkpoint = await call(
            session,
            "checkpoint_record",
            {
                "thread_id": thread_id,
                "workspace_id": workspace_id,
                "mission_ref": "direct-chatgpt-coding-capability",
                "frontier": "fixture repaired through primitive MCP tools",
                "next_action": "run a representative repository A/B test",
                "validation_state": "passed",
                "refs": ["pytest:2-passed", "git-diff-check:passed"],
            },
        )
        resumed = await call(
            session,
            "workspace_open",
            {
                "path": workspace,
                "target_path": "src/coding_smoke/pricing.py",
                "thread_id": thread_id,
            },
        )
        if resumed["bootstrap"]["durable_state"]["event_count"] < 1:
            raise AssertionError(
                "workspace bootstrap did not project durable checkpoint"
            )
        return {
            "tool_count": len(tools.tools),
            "tool_abi": {
                "version": ABI_VERSION,
                "fingerprint_sha256": ABI_FINGERPRINT_SHA256,
            },
            "workspace": opened,
            "bootstrap_instruction_paths": [
                item["path"] for item in bootstrap["instructions"]
            ],
            "bootstrap_skill_names": [item["name"] for item in bootstrap["skills"]],
            "source_before": source_before,
            "failing_test_exit_code": failing["exit_code"],
            "edit": edited,
            "passing_test_exit_code": passing["exit_code"],
            "passing_test_output": passing["output"],
            "git_diff": diff,
            "checkpoint": checkpoint,
            "resumed_durable_state": resumed["bootstrap"]["durable_state"],
        }


async def qualify(
    url: str,
    workspace: str,
    thread_id: str,
    wait_seconds: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + wait_seconds
    last_error: BaseException | None = None
    while time.monotonic() < deadline:
        try:
            return await qualify_once(url, workspace, thread_id)
        except (ExceptionGroup, OSError, TimeoutError) as exc:
            last_error = exc
            await asyncio.sleep(0.5)
    if last_error is not None:
        raise last_error
    raise RuntimeError("MCP readiness deadline elapsed")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8765/mcp")
    parser.add_argument("--workspace", default="/workspace")
    parser.add_argument("--thread-id", default="coding-fixture-qualification")
    parser.add_argument("--wait-seconds", type=float, default=30.0)
    args = parser.parse_args()
    print(
        json.dumps(
            asyncio.run(
                qualify(
                    args.url,
                    args.workspace,
                    thread_id=args.thread_id,
                    wait_seconds=args.wait_seconds,
                )
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

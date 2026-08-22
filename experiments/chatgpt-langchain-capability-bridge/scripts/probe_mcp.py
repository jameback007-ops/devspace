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


async def probe_once(url: str, workspace: str) -> None:
    async with (
        streamable_http_client(url) as streams,
        ClientSession(streams[0], streams[1]) as session,
    ):
        await session.initialize()
        tools = await session.list_tools()
        tool_names = tuple(sorted(tool.name for tool in tools.tools))
        if tool_names != ABI_TOOL_NAMES:
            raise AssertionError(f"tool ABI mismatch: {tool_names!r}")
        print("tools:", ", ".join(tool.name for tool in tools.tools))
        manifest = structured(await session.call_tool("capability_manifest", {}))
        if manifest["tool_abi"] != {
            **manifest["tool_abi"],
            "version": ABI_VERSION,
            "fingerprint_sha256": ABI_FINGERPRINT_SHA256,
        }:
            raise AssertionError("capability manifest ABI identity mismatch")
        opened = structured(
            await session.call_tool(
                "workspace_open",
                {"path": workspace, "target_path": "src/coding_smoke/pricing.py"},
            )
        )
        workspace_id = opened["workspace_id"]
        print("workspace:", json.dumps(opened, indent=2))
        result = structured(
            await session.call_tool(
                "execute",
                {
                    "workspace_id": workspace_id,
                    "command": "python3 -m pytest -q",
                    "timeout": 120,
                },
            )
        )
        print("expected failing fixture result:")
        print(json.dumps(result, indent=2))


async def probe(url: str, workspace: str, wait_seconds: float) -> None:
    deadline = time.monotonic() + wait_seconds
    last_error: BaseException | None = None
    while time.monotonic() < deadline:
        try:
            await probe_once(url, workspace)
            return
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
    parser.add_argument("--wait-seconds", type=float, default=20.0)
    args = parser.parse_args()
    asyncio.run(probe(args.url, args.workspace, args.wait_seconds))


if __name__ == "__main__":
    main()

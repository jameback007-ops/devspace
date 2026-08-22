from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


def structured(result: Any) -> Any:
    value = getattr(result, "structured_content", None)
    if value is not None:
        return value
    content = getattr(result, "content", None)
    if content and hasattr(content[0], "text"):
        return json.loads(content[0].text)
    raise RuntimeError(f"tool returned no structured content: {result!r}")


async def call_once(url: str, name: str, arguments: dict[str, Any]) -> Any:
    async with (
        streamable_http_client(url) as streams,
        ClientSession(streams[0], streams[1]) as session,
    ):
        await session.initialize()
        result = await session.call_tool(name, arguments)
        if result.is_error:
            raise RuntimeError(f"{name} failed: {result.content!r}")
        return structured(result)


async def call(
    url: str,
    name: str,
    arguments: dict[str, Any],
    wait_seconds: float,
) -> Any:
    deadline = time.monotonic() + wait_seconds
    last_error: BaseException | None = None
    while time.monotonic() < deadline:
        try:
            return await call_once(url, name, arguments)
        except (ExceptionGroup, OSError, TimeoutError) as exc:
            last_error = exc
            await asyncio.sleep(0.5)
    if last_error is not None:
        raise last_error
    raise RuntimeError("MCP readiness deadline elapsed")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Call exactly one primitive bridge tool for model-owner rehearsal."
    )
    parser.add_argument("tool")
    parser.add_argument(
        "arguments",
        nargs="?",
        default="{}",
        help="JSON object, or '-' to read JSON from stdin",
    )
    parser.add_argument("--url", default="http://127.0.0.1:8765/mcp")
    parser.add_argument("--wait-seconds", type=float, default=20.0)
    args = parser.parse_args()
    raw = sys.stdin.read() if args.arguments == "-" else args.arguments
    arguments = json.loads(raw)
    if not isinstance(arguments, dict):
        raise SystemExit("arguments must decode to a JSON object")
    print(
        json.dumps(
            asyncio.run(
                call(args.url, args.tool, arguments, wait_seconds=args.wait_seconds)
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

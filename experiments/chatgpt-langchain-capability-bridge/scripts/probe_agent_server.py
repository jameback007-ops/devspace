from __future__ import annotations

import argparse
import asyncio
import json
import urllib.request
from typing import Any

from langgraph_sdk import get_sync_client
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


async def probe_mcp(base_url: str, workspace: str) -> dict[str, Any]:
    async with (
        streamable_http_client(f"{base_url}/coding/mcp") as streams,
        ClientSession(streams[0], streams[1]) as session,
    ):
        await session.initialize()
        tools = await session.list_tools()
        opened = structured(
            await session.call_tool("workspace_open", {"path": workspace})
        )
        recorded = structured(
            await session.call_tool(
                "checkpoint_record",
                {
                    "thread_id": "agent-server-insertion-probe",
                    "workspace_id": opened["workspace_id"],
                    "mission_ref": "agent-server-custom-mcp-route",
                    "frontier": "primitive MCP tools coexist with Agent Server",
                    "next_action": "run the WebChat coding qualification",
                    "validation_state": "passed",
                },
            )
        )
        return {
            "tool_count": len(tools.tools),
            "tool_names": [tool.name for tool in tools.tools],
            "workspace": opened,
            "checkpoint": recorded,
        }


def probe_agent_server(base_url: str) -> dict[str, Any]:
    with urllib.request.urlopen(f"{base_url}/ok", timeout=5) as response:
        health = json.loads(response.read())
    client = get_sync_client(url=base_url)
    thread = client.threads.create(graph_id="bridge_journal")
    result = client.runs.wait(
        thread["thread_id"],
        "bridge_journal",
        input={"events": [{"kind": "native-agent-server-run", "status": "passed"}]},
    )
    state = client.threads.get_state(thread["thread_id"])
    return {
        "health": health,
        "thread_id": thread["thread_id"],
        "run_result": result,
        "checkpoint": state["checkpoint"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:2026")
    parser.add_argument(
        "--workspace", default="/tmp/chatgpt-langchain-agent-server-workspace"
    )
    args = parser.parse_args()
    print(
        json.dumps(
            {
                "agent_server": probe_agent_server(args.url),
                "custom_mcp": asyncio.run(probe_mcp(args.url, args.workspace)),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

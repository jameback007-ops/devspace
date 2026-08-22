from __future__ import annotations

import argparse
import asyncio
import json
import urllib.request
from typing import Any

from langgraph_sdk import get_sync_client
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


async def probe_mcp(base_url: str, workspace: str) -> dict[str, Any]:
    async with (
        streamable_http_client(f"{base_url}/coding/mcp") as streams,
        ClientSession(streams[0], streams[1]) as session,
    ):
        await session.initialize()
        tools = await session.list_tools()
        tool_names = tuple(sorted(tool.name for tool in tools.tools))
        if tool_names != ABI_TOOL_NAMES:
            raise AssertionError(f"tool ABI mismatch: {tool_names!r}")
        manifest = structured(await session.call_tool("capability_manifest", {}))
        if manifest["tool_abi"]["version"] != ABI_VERSION:
            raise AssertionError("tool ABI version mismatch")
        if manifest["tool_abi"]["fingerprint_sha256"] != ABI_FINGERPRINT_SHA256:
            raise AssertionError("tool ABI fingerprint mismatch")
        opened = structured(
            await session.call_tool(
                "workspace_open",
                {
                    "path": workspace,
                    "thread_id": "agent-server-insertion-probe",
                },
            )
        )
        workstream = opened["bootstrap"]["workstream"]
        if not workstream["agent_thread_id"]:
            raise AssertionError(
                "workspace_open did not bind a native Agent Server thread"
            )
        if workstream["workstream_ref"] != "agent-server-insertion-probe":
            raise AssertionError("workstream ref changed during native binding")
        workstream_search = structured(
            await session.call_tool(
                "runtime_thread",
                {
                    "action": "search",
                    "metadata": {
                        "bridge_workstream_ref": "agent-server-insertion-probe"
                    },
                    "limit": 10,
                },
            )
        )
        matching_thread_ids = {
            item["thread_id"] for item in workstream_search["threads"]
        }
        if workstream["agent_thread_id"] not in matching_thread_ids:
            raise AssertionError(
                "native workstream thread was not searchable by metadata"
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
        runtime_thread = structured(
            await session.call_tool(
                "runtime_thread",
                {"action": "create", "graph_id": "bridge_journal"},
            )
        )
        runtime_run = structured(
            await session.call_tool(
                "runtime_run",
                {
                    "action": "invoke",
                    "thread_id": runtime_thread["thread_id"],
                    "assistant_id": "bridge_journal",
                    "run_input": {
                        "events": [
                            {
                                "kind": "runtime-plane-probe",
                                "status": "passed",
                            }
                        ]
                    },
                },
            )
        )
        todos = [
            {"content": "inspect native interrupt", "status": "completed"},
            {"content": "resume through Command", "status": "in_progress"},
        ]
        runtime_todos_write = structured(
            await session.call_tool(
                "runtime_thread",
                {
                    "action": "todos_write",
                    "thread_id": runtime_thread["thread_id"],
                    "todos": todos,
                },
            )
        )
        runtime_todos_read = structured(
            await session.call_tool(
                "runtime_thread",
                {
                    "action": "todos_read",
                    "thread_id": runtime_thread["thread_id"],
                },
            )
        )
        if runtime_todos_read["todos"] != todos:
            raise AssertionError("native TodoListMiddleware state did not round-trip")

        hitl_thread = structured(
            await session.call_tool(
                "runtime_thread",
                {"action": "create", "graph_id": "bridge_hitl"},
            )
        )
        hitl_initial = structured(
            await session.call_tool(
                "runtime_run",
                {
                    "action": "invoke",
                    "thread_id": hitl_thread["thread_id"],
                    "assistant_id": "bridge_hitl",
                    "run_input": {
                        "action_request": {
                            "name": "qualification_action",
                            "args": {"scope": "disposable"},
                        }
                    },
                },
            )
        )
        hitl_interrupted_state = structured(
            await session.call_tool(
                "runtime_thread",
                {"action": "state", "thread_id": hitl_thread["thread_id"]},
            )
        )
        hitl_resume_run = structured(
            await session.call_tool(
                "runtime_run",
                {
                    "action": "resume",
                    "thread_id": hitl_thread["thread_id"],
                    "assistant_id": "bridge_hitl",
                    "run_command": {"resume": {"decisions": [{"type": "approve"}]}},
                    "durability": "sync",
                },
            )
        )
        hitl_resumed = structured(
            await session.call_tool(
                "runtime_run",
                {
                    "action": "join",
                    "thread_id": hitl_thread["thread_id"],
                    "run_id": hitl_resume_run["run_id"],
                },
            )
        )
        structured(
            await session.call_tool(
                "runtime_store",
                {
                    "action": "put",
                    "namespace": ["probe"],
                    "key": "state",
                    "value": {"validated": True},
                },
            )
        )
        runtime_store = structured(
            await session.call_tool(
                "runtime_store",
                {
                    "action": "get",
                    "namespace": ["probe"],
                    "key": "state",
                },
            )
        )
        return {
            "tool_count": len(tools.tools),
            "tool_names": [tool.name for tool in tools.tools],
            "tool_abi": {
                "version": ABI_VERSION,
                "fingerprint_sha256": ABI_FINGERPRINT_SHA256,
            },
            "workspace": opened,
            "workstream_search": workstream_search,
            "checkpoint": recorded,
            "runtime_thread": runtime_thread,
            "runtime_run": runtime_run,
            "runtime_todos_write": runtime_todos_write,
            "runtime_todos_read": runtime_todos_read,
            "hitl_thread": hitl_thread,
            "hitl_initial": hitl_initial,
            "hitl_interrupted_state": hitl_interrupted_state,
            "hitl_resume_run": hitl_resume_run,
            "hitl_resumed": hitl_resumed,
            "runtime_store": runtime_store,
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

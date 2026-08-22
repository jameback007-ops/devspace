from __future__ import annotations

import argparse
import asyncio
import json
import time
from typing import Any

from langgraph_sdk import get_sync_client
from langsmith import Client
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


async def collect_langsmith_thread(
    *,
    client: Client,
    project_id: str,
    workstream_ref: str,
    timeout_seconds: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    deadline = time.monotonic() + timeout_seconds
    latest_threads: list[dict[str, Any]] = []
    latest_traces: list[dict[str, Any]] = []

    while time.monotonic() < deadline:
        threads: list[dict[str, Any]] = []
        query = client.threads.query(
            project_id=project_id,
            page_size=100,
            timeout=30.0,
        )
        async for item in query:
            raw = item.model_dump(mode="json")
            if (raw.get("thread_id") or raw.get("id")) == workstream_ref:
                threads.append(raw)

        traces: list[dict[str, Any]] = []
        trace_query = client.threads.list_traces(
            workstream_ref,
            project_id=project_id,
            page_size=100,
            selects=[
                "THREAD_ID",
                "TRACE_ID",
                "START_TIME",
                "END_TIME",
                "LATENCY",
                "NAME",
                "ERROR",
            ],
            timeout=30.0,
        )
        async for item in trace_query:
            traces.append(item.model_dump(mode="json"))

        latest_threads = threads
        latest_traces = traces
        if len(threads) == 1 and len(traces) >= 3:
            return threads, traces
        await asyncio.sleep(0.5)

    return latest_threads, latest_traces


async def probe(args: argparse.Namespace) -> dict[str, Any]:
    mcp_url = f"{args.agent_server_url.rstrip('/')}{args.mcp_path}"
    async with (
        streamable_http_client(mcp_url) as streams,
        ClientSession(streams[0], streams[1]) as session,
    ):
        await session.initialize()
        tools = await session.list_tools()
        tool_names = tuple(sorted(tool.name for tool in tools.tools))
        if tool_names != ABI_TOOL_NAMES:
            raise AssertionError(f"tool ABI mismatch: {tool_names!r}")

        manifest = structured(await session.call_tool("capability_manifest", {}))
        tool_abi = manifest["tool_abi"]
        if tool_abi["version"] != ABI_VERSION:
            raise AssertionError("tool ABI version mismatch")
        if tool_abi["fingerprint_sha256"] != ABI_FINGERPRINT_SHA256:
            raise AssertionError("tool ABI fingerprint mismatch")

        opened = structured(
            await session.call_tool(
                "workspace_open",
                {
                    "path": args.workspace,
                    "target_path": args.target_path,
                    "thread_id": args.workstream_ref,
                },
            )
        )
        workspace_id = opened["workspace_id"]
        structured(
            await session.call_tool(
                "ls",
                {"workspace_id": workspace_id, "path": "."},
            )
        )
        structured(
            await session.call_tool(
                "checkpoint_read",
                {"thread_id": args.workstream_ref},
            )
        )

    binding = opened["bootstrap"]["workstream"]
    agent_thread_id = binding.get("agent_thread_id")
    if not agent_thread_id:
        raise AssertionError("workspace_open did not bind a native Agent Server thread")

    agent_client = get_sync_client(url=args.agent_server_url, timeout=30.0)
    native_threads = agent_client.threads.search(
        metadata={
            "chatgpt_langchain_bridge": "v2",
            "bridge_workstream_ref": args.workstream_ref,
            "bridge_reasoning_owner": "chatgpt_webchat",
        },
        limit=10,
        sort_by="updated_at",
        sort_order="desc",
    )
    if len(native_threads) != 1:
        raise AssertionError(
            f"expected exactly one native Agent Server thread, got {len(native_threads)}"
        )
    native_thread = native_threads[0]
    if native_thread["thread_id"] != agent_thread_id:
        raise AssertionError("workspace binding and Agent Server search disagree")

    langsmith_client = Client()
    project = langsmith_client.read_project(project_name=args.langsmith_project)
    smith_threads, smith_traces = await collect_langsmith_thread(
        client=langsmith_client,
        project_id=str(project.id),
        workstream_ref=args.workstream_ref,
        timeout_seconds=args.langsmith_wait_seconds,
    )
    if len(smith_threads) != 1:
        raise AssertionError(f"expected one LangSmith thread, got {len(smith_threads)}")

    safe_traces = [
        {
            "thread_id": trace.get("thread_id"),
            "trace_id": trace.get("trace_id"),
            "name": trace.get("name"),
            "start_time": trace.get("start_time"),
            "end_time": trace.get("end_time"),
            "latency": trace.get("latency"),
            "error_present": bool(trace.get("error")),
        }
        for trace in smith_traces
    ]

    return {
        "schema_version": "chatgpt-langchain-workstream-observability-probe.v1",
        "tool_abi": {
            "version": ABI_VERSION,
            "tool_count": len(tool_names),
            "fingerprint_sha256": ABI_FINGERPRINT_SHA256,
        },
        "workstream": binding,
        "agent_server": {
            "thread_count": len(native_threads),
            "thread_id": native_thread["thread_id"],
            "status": native_thread.get("status"),
            "created_at": native_thread.get("created_at"),
            "updated_at": native_thread.get("updated_at"),
            "metadata": native_thread.get("metadata", {}),
        },
        "langsmith": {
            "project_id": str(project.id),
            "project_name": args.langsmith_project,
            "thread_count": len(smith_threads),
            "trace_count": len(safe_traces),
            "traces": safe_traces,
        },
        "authority": {
            "custom_activity_database_created": False,
            "custom_dashboard_created": False,
            "agent_runtime_state_source": "langgraph_agent_server",
            "trace_thread_source": "langsmith_threads",
            "studio_ui_source": "langsmith_studio",
            "hidden_webchat_reasoning_observable": False,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent-server-url", default="http://127.0.0.1:2026")
    parser.add_argument("--mcp-path", default="/coding/mcp")
    parser.add_argument(
        "--workspace", default="/tmp/chatgpt-langchain-agent-server-workspace"
    )
    parser.add_argument("--target-path", default=".")
    parser.add_argument(
        "--workstream-ref", default="agent-server-workstream-observability-probe"
    )
    parser.add_argument(
        "--langsmith-project", default="zes-chatgpt-langchain-capability-bridge"
    )
    parser.add_argument("--langsmith-wait-seconds", type=float, default=20.0)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(probe(args)), indent=2))


if __name__ == "__main__":
    main()

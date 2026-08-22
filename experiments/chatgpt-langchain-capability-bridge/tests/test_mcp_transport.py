from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_port(port: int, process: subprocess.Popen[str]) -> None:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate(timeout=1)
            raise AssertionError(
                f"bridge exited early\nstdout={stdout}\nstderr={stderr}"
            )
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.1)
    raise AssertionError("bridge did not start")


def _structured(result: Any) -> Any:
    value = getattr(result, "structured_content", None)
    if value is not None:
        return value
    value = getattr(result, "structuredContent", None)
    if value is not None:
        return value
    content = getattr(result, "content", None)
    if content and hasattr(content[0], "text"):
        import json

        return json.loads(content[0].text)
    raise AssertionError(f"no structured result: {result!r}")


@pytest.mark.asyncio
async def test_streamable_http_tool_roundtrip(tmp_path: Path) -> None:
    (tmp_path / "hello.txt").write_text("before\n", encoding="utf-8")
    (tmp_path / "AGENTS.md").write_text(
        "# Fixture\nUse the smallest valid edit.\n", encoding="utf-8"
    )
    skill_dir = tmp_path / ".agents" / "skills" / "fixture-coding"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: fixture-coding\n"
        "description: Repair the fixture with validation\n"
        "---\n"
        "# Fixture coding\n",
        encoding="utf-8",
    )
    port = _free_port()
    env = os.environ.copy()
    env.update(
        {
            "BRIDGE_ALLOWED_ROOTS": str(tmp_path),
            "BRIDGE_PORT": str(port),
            "BRIDGE_HOST": "127.0.0.1",
            "BRIDGE_STATE_DB": str(tmp_path / "state.sqlite"),
        }
    )
    process = subprocess.Popen(  # noqa: ASYNC220 - server lifecycle is the test target.
        [sys.executable, "-m", "chatgpt_langchain_bridge.server"],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        _wait_for_port(port, process)
        async with (
            streamable_http_client(f"http://127.0.0.1:{port}/mcp") as streams,
            ClientSession(streams[0], streams[1]) as session,
        ):
            await session.initialize()
            tools = await session.list_tools()
            names = {tool.name for tool in tools.tools}
            assert {
                "workspace_open",
                "read_file",
                "edit_file",
                "execute",
                "checkpoint_record",
            } <= names

            opened = _structured(
                await session.call_tool(
                    "workspace_open",
                    {
                        "path": str(tmp_path),
                        "target_path": "hello.txt",
                        "thread_id": "transport-test",
                    },
                )
            )
            workspace_id = opened["workspace_id"]
            assert opened["bootstrap"]["instructions"][0]["path"] == "AGENTS.md"
            assert opened["bootstrap"]["skills"][0]["name"] == "fixture-coding"
            assert opened["bootstrap"]["durable_state"]["state"] == "empty"

            edited = _structured(
                await session.call_tool(
                    "edit_file",
                    {
                        "workspace_id": workspace_id,
                        "file_path": "hello.txt",
                        "old_string": "before",
                        "new_string": "after",
                    },
                )
            )
            assert edited["error"] is None

            executed = _structured(
                await session.call_tool(
                    "execute",
                    {
                        "workspace_id": workspace_id,
                        "command": "python3 -c \"assert open('hello.txt').read().strip() == 'after'\"",
                    },
                )
            )
            assert executed["exit_code"] == 0

            checkpoint = _structured(
                await session.call_tool(
                    "checkpoint_record",
                    {
                        "thread_id": "transport-test",
                        "workspace_id": workspace_id,
                        "mission_ref": "transport-smoke",
                        "frontier": "source edited",
                        "next_action": "finish",
                        "validation_state": "passed",
                    },
                )
            )
            assert checkpoint["latest"]["validation_state"] == "passed"
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()

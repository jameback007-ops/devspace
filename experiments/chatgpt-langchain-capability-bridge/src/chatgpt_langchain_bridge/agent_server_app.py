from __future__ import annotations

import os

from chatgpt_langchain_bridge.server import build_server
from chatgpt_langchain_bridge.state import AgentServerStoreJournal

# Agent Server merges routes from this Starlette application with its native
# runs, threads, assistants, store, auth, and observability APIs. The route is
# deliberately distinct from Agent Server's built-in graph-as-tool `/mcp`
# endpoint because ChatGPT must call primitive coding tools directly.
app = build_server(journal=AgentServerStoreJournal()).streamable_http_app(
    streamable_http_path=os.environ.get("BRIDGE_MCP_PATH", "/coding/mcp"),
    json_response=True,
    stateless_http=True,
    host=os.environ.get("BRIDGE_HOST", "127.0.0.1"),
)

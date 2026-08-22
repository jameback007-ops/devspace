from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

from .registry import BridgeConfig, WorkspaceRegistry
from .state import CheckpointJournal, Journal

READ_ONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
MUTATION = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=False,
    openWorldHint=False,
)
DESTRUCTIVE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=False,
    openWorldHint=False,
)
EXECUTION = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=False,
    openWorldHint=True,
)


def build_server(
    registry: WorkspaceRegistry | None = None,
    journal: Journal | None = None,
) -> MCPServer:
    registry = registry or WorkspaceRegistry(BridgeConfig.from_environment())
    journal = journal or CheckpointJournal(
        Path(os.environ.get("BRIDGE_STATE_DB", ".bridge-state/checkpoints.sqlite"))
    )

    server = MCPServer(
        name="chatgpt-langchain-capability-bridge",
        title="ChatGPT LangChain Coding Capability Bridge",
        version="0.1.0",
        instructions=(
            "ChatGPT is the reasoning and coding owner. Call primitive tools directly; "
            "do not delegate coding to another model. File paths are workspace-relative. "
            "Shell commands start in the workspace root. The shell backend must run inside "
            "an isolated container or supported Deep Agents sandbox."
        ),
    )

    @server.tool(annotations=READ_ONLY, structured_output=True)
    def capability_manifest() -> dict[str, Any]:
        """Describe the exact native components, capability surface, and known limits."""

        return registry.capability_manifest()

    @server.tool(annotations=READ_ONLY, structured_output=True)
    def workspace_open(path: str) -> dict[str, Any]:
        """Open an allowed repository or directory and return a reusable workspace ID."""

        return registry.open(path)

    @server.tool(annotations=READ_ONLY, structured_output=True)
    def workspace_status(workspace_id: str) -> dict[str, Any]:
        """Read one opened workspace's stable root and backend identity."""

        return registry.status(workspace_id)

    @server.tool(annotations=READ_ONLY, structured_output=True)
    def workspace_list() -> list[dict[str, Any]]:
        """List workspaces opened by this bridge process."""

        return registry.list()

    @server.tool(annotations=READ_ONLY, structured_output=True)
    def ls(workspace_id: str, path: str = ".") -> dict[str, Any]:
        """List a workspace-relative directory through Deep Agents."""

        return registry.ls(workspace_id, path)

    @server.tool(annotations=READ_ONLY, structured_output=True)
    def read_file(
        workspace_id: str, file_path: str, offset: int = 0, limit: int = 2000
    ) -> dict[str, Any]:
        """Read a workspace-relative text or supported file with line pagination."""

        return registry.read(workspace_id, file_path, offset=offset, limit=limit)

    @server.tool(annotations=MUTATION, structured_output=True)
    def write_file(workspace_id: str, file_path: str, content: str) -> dict[str, Any]:
        """Create or overwrite one workspace-relative file through Deep Agents."""

        return registry.write(workspace_id, file_path, content)

    @server.tool(annotations=MUTATION, structured_output=True)
    def edit_file(
        workspace_id: str,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> dict[str, Any]:
        """Apply an exact string replacement to one workspace-relative file."""

        return registry.edit(
            workspace_id,
            file_path,
            old_string,
            new_string,
            replace_all=replace_all,
        )

    @server.tool(annotations=DESTRUCTIVE, structured_output=True)
    def delete_file(workspace_id: str, file_path: str) -> dict[str, Any]:
        """Delete one workspace-relative file."""

        return registry.delete(workspace_id, file_path)

    @server.tool(annotations=READ_ONLY, structured_output=True)
    def glob(
        workspace_id: str, pattern: str, path: str | None = None
    ) -> dict[str, Any]:
        """Find files using Deep Agents glob semantics."""

        return registry.glob(workspace_id, pattern, path)

    @server.tool(annotations=READ_ONLY, structured_output=True)
    def grep(
        workspace_id: str,
        pattern: str,
        path: str | None = None,
        glob_pattern: str | None = None,
        max_count: int | None = 200,
        context_lines: int = 0,
    ) -> dict[str, Any]:
        """Search workspace text through Deep Agents grep."""

        return registry.grep(
            workspace_id,
            pattern,
            path,
            glob_pattern,
            max_count=max_count,
            context_lines=context_lines,
        )

    @server.tool(annotations=EXECUTION, structured_output=True)
    def execute(
        workspace_id: str, command: str, timeout: int | None = None
    ) -> dict[str, Any]:
        """Run a shell command in the workspace execution environment.

        This is intentionally full coding capability: Git, dependency tools,
        tests, builds, and CLIs are available when installed in the container.
        """

        return registry.execute(workspace_id, command, timeout=timeout)

    @server.tool(annotations=MUTATION, structured_output=True)
    def checkpoint_record(
        thread_id: str,
        workspace_id: str,
        mission_ref: str,
        frontier: str,
        next_action: str,
        validation_state: str = "unknown",
        refs: list[str] | None = None,
    ) -> dict[str, Any]:
        """Append a durable tool-plane checkpoint through native LangGraph state."""

        registry.status(workspace_id)
        event = {
            "workspace_id": workspace_id,
            "mission_ref": mission_ref,
            "frontier": frontier,
            "next_action": next_action,
            "validation_state": validation_state,
            "refs": refs or [],
        }
        return journal.record(thread_id, event)

    @server.tool(annotations=READ_ONLY, structured_output=True)
    def checkpoint_read(thread_id: str) -> dict[str, Any]:
        """Read the durable LangGraph checkpoint history for one bridge thread."""

        return journal.read(thread_id)

    return server


def main() -> None:
    server = build_server()
    transport = os.environ.get("BRIDGE_TRANSPORT", "streamable-http")
    if transport == "stdio":
        server.run(transport="stdio")
        return
    server.run(
        transport="streamable-http",
        host=os.environ.get("BRIDGE_HOST", "127.0.0.1"),
        port=int(os.environ.get("BRIDGE_PORT", "8765")),
        streamable_http_path=os.environ.get("BRIDGE_MCP_PATH", "/mcp"),
        json_response=True,
        stateless_http=True,
    )


if __name__ == "__main__":
    main()

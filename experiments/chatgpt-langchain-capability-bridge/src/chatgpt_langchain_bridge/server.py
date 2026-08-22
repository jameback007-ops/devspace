from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

from .registry import BridgeConfig, WorkspaceRegistry
from .runtime import CapabilityRuntime
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
    capabilities: CapabilityRuntime | None = None,
) -> MCPServer:
    registry = registry or WorkspaceRegistry(BridgeConfig.from_environment())
    journal = journal or CheckpointJournal(
        Path(os.environ.get("BRIDGE_STATE_DB", ".bridge-state/checkpoints.sqlite"))
    )
    capabilities = capabilities or CapabilityRuntime(registry, journal)
    instrument = capabilities.observability.instrument

    server = MCPServer(
        name="chatgpt-langchain-capability-bridge",
        title="ChatGPT LangChain Coding Capability Bridge",
        version="0.2.0",
        instructions=(
            "ChatGPT is the reasoning and coding owner. Call primitive coding tools "
            "directly. Use context_discover/context_read for native Deep Agents skills "
            "and AGENTS.md memory. Optional specialist_task calls are explicit helpers, "
            "never the default coding path. File paths are workspace-relative. Shell "
            "commands start in the workspace root. Local shell execution must run inside "
            "an isolated container; persistent PTY processes require a configured native "
            "sandbox provider with resumable process handles. "
            "Use runtime_thread todos_read/todos_write for native TodoListMiddleware "
            "state, and runtime_run run_command for native LangGraph interrupt resume. "
            "This MCP plane cannot replace ChatGPT's hidden system prompt or automatically "
            "summarize ChatGPT's hidden conversation history."
        ),
    )

    @server.tool(annotations=READ_ONLY, structured_output=True)
    @instrument("capability_manifest")
    def capability_manifest() -> dict[str, Any]:
        """Describe the exact native components, capability surface, and known limits."""

        return capabilities.manifest()

    @server.tool(annotations=READ_ONLY, structured_output=True)
    @instrument("workspace_open")
    def workspace_open(
        path: str,
        target_path: str = ".",
        thread_id: str = "",
    ) -> dict[str, Any]:
        """Open one workspace and return a bounded automatic context bootstrap.

        The result includes hierarchical AGENTS-style instructions for the
        current target path, native skill metadata, a top-level repository map,
        the current capability manifest, and an optional compact durable-state
        pointer. Full skills remain lazy through context_read; volatile Git,
        test, process, runtime, and peer state are not cached here.
        """

        return capabilities.open_workspace(
            path,
            target_path=target_path,
            thread_id=thread_id,
        )

    @server.tool(annotations=READ_ONLY, structured_output=True)
    @instrument("workspace_status")
    def workspace_status(workspace_id: str) -> dict[str, Any]:
        """Read one opened workspace's stable root and backend identity."""

        return registry.status(workspace_id)

    @server.tool(annotations=READ_ONLY, structured_output=True)
    @instrument("workspace_list")
    def workspace_list() -> list[dict[str, Any]]:
        """List workspaces opened by this bridge process."""

        return registry.list()

    @server.tool(annotations=READ_ONLY, structured_output=True)
    @instrument("ls")
    def ls(workspace_id: str, path: str = ".") -> dict[str, Any]:
        """List a workspace-relative directory through Deep Agents."""

        return registry.ls(workspace_id, path)

    @server.tool(annotations=READ_ONLY, structured_output=True)
    @instrument("read_file")
    def read_file(
        workspace_id: str, file_path: str, offset: int = 0, limit: int = 2000
    ) -> dict[str, Any]:
        """Read a workspace-relative text or supported file with line pagination."""

        return registry.read(workspace_id, file_path, offset=offset, limit=limit)

    @server.tool(annotations=MUTATION, structured_output=True)
    @instrument("write_file")
    def write_file(workspace_id: str, file_path: str, content: str) -> dict[str, Any]:
        """Create or overwrite one workspace-relative file through Deep Agents."""

        return registry.write(workspace_id, file_path, content)

    @server.tool(annotations=MUTATION, structured_output=True)
    @instrument("edit_file")
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
    @instrument("delete_file")
    def delete_file(workspace_id: str, file_path: str) -> dict[str, Any]:
        """Delete one workspace-relative file."""

        return registry.delete(workspace_id, file_path)

    @server.tool(annotations=READ_ONLY, structured_output=True)
    @instrument("glob")
    def glob(
        workspace_id: str, pattern: str, path: str | None = None
    ) -> dict[str, Any]:
        """Find files using Deep Agents glob semantics."""

        return registry.glob(workspace_id, pattern, path)

    @server.tool(annotations=READ_ONLY, structured_output=True)
    @instrument("grep")
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
    @instrument("execute")
    def execute(
        workspace_id: str, command: str, timeout: int | None = None
    ) -> dict[str, Any]:
        """Run a shell command in the workspace execution environment.

        This is intentionally full coding capability: Git, dependency tools,
        tests, builds, and CLIs are available when installed in the container.
        """

        return registry.execute(workspace_id, command, timeout=timeout)

    @server.tool(annotations=MUTATION, structured_output=True)
    @instrument("checkpoint_record")
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
    @instrument("checkpoint_read")
    def checkpoint_read(thread_id: str) -> dict[str, Any]:
        """Read the bounded current LangGraph checkpoint journal for one bridge thread."""

        return journal.read(thread_id)

    @server.tool(annotations=READ_ONLY, structured_output=True)
    @instrument("context_discover")
    def context_discover(
        workspace_id: str,
        query: str = "",
        target_path: str = ".",
        limit: int = 50,
    ) -> dict[str, Any]:
        """Discover native Deep Agents skills and AGENTS.md memory.

        Skill metadata is returned first for progressive disclosure. Read only
        the relevant full skill or memory file with ``context_read``.
        """

        return capabilities.context.discover(
            workspace_id,
            query=query,
            target_path=target_path,
            limit=limit,
        )

    @server.tool(annotations=READ_ONLY, structured_output=True)
    @instrument("context_read")
    def context_read(
        workspace_id: str,
        context_kind: Literal["skill", "memory"],
        path: str,
        offset: int = 0,
        limit: int = 400,
    ) -> dict[str, Any]:
        """Read one skill or AGENTS.md memory path returned by context_discover."""

        return capabilities.context.read(
            workspace_id,
            context_kind,
            path,
            offset=offset,
            limit=limit,
        )

    @server.tool(annotations=MUTATION, structured_output=True)
    @instrument("artifact_transfer")
    def artifact_transfer(
        workspace_id: str,
        action: Literal["upload", "download"],
        file_path: str,
        content_base64: str | None = None,
    ) -> dict[str, Any]:
        """Upload or download one bounded binary artifact through native backend transfer."""

        return capabilities.artifacts.transfer(
            workspace_id,
            action,
            file_path,
            content_base64,
        )

    @server.tool(annotations=EXECUTION, structured_output=True)
    @instrument("sandbox_workspace")
    def sandbox_workspace(
        action: Literal[
            "manifest", "list", "create", "attach", "status", "detach", "stop", "delete"
        ],
        sandbox_name: str = "",
        snapshot_id: str = "",
        snapshot_name: str = "",
        workspace_root: str = "",
        workspace_id: str = "",
        idle_ttl_seconds: int = 900,
        delete_after_stop_seconds: int = 3600,
    ) -> dict[str, Any]:
        """Inspect, provision, attach, stop, or delete an allowlisted native sandbox."""

        return capabilities.sandboxes.operate(
            action,
            sandbox_name=sandbox_name,
            snapshot_id=snapshot_id,
            snapshot_name=snapshot_name,
            workspace_root=workspace_root,
            workspace_id=workspace_id,
            idle_ttl_seconds=idle_ttl_seconds,
            delete_after_stop_seconds=delete_after_stop_seconds,
        )

    @server.tool(annotations=EXECUTION, structured_output=True)
    @instrument("process")
    def process(
        action: Literal[
            "manifest", "list", "start", "resume", "poll", "input", "cancel"
        ],
        workspace_id: str = "",
        process_id: str = "",
        command: str = "",
        chars: str = "",
        after_sequence: int = 0,
        limit: int = 100,
        pty: bool = True,
        ttl_seconds: int = 3600,
        idle_timeout_seconds: int = 300,
        stdout_offset: int = 0,
        stderr_offset: int = 0,
        wait_seconds: float = 0,
    ) -> dict[str, Any]:
        """Control a native resumable sandbox PTY command.

        Use ``start`` once, then ``poll`` with the last sequence and an optional
        bounded wait. ``input`` writes stdin, ``cancel`` kills the native process
        group, and ``resume`` reattaches by command ID and byte offsets after
        bridge restart.
        """

        return capabilities.processes.operate(
            action,
            workspace_id=workspace_id,
            process_id=process_id,
            command=command,
            chars=chars,
            after_sequence=after_sequence,
            limit=limit,
            pty=pty,
            ttl_seconds=ttl_seconds,
            idle_timeout_seconds=idle_timeout_seconds,
            stdout_offset=stdout_offset,
            stderr_offset=stderr_offset,
            wait_seconds=wait_seconds,
        )

    @server.tool(annotations=EXECUTION, structured_output=True)
    @instrument("runtime_thread")
    def runtime_thread(
        action: Literal[
            "create",
            "get",
            "state",
            "history",
            "search",
            "update_state",
            "todos_read",
            "todos_write",
            "delete",
        ],
        thread_id: str = "",
        graph_id: str = "",
        metadata: dict[str, Any] | None = None,
        values: dict[str, Any] | list[dict[str, Any]] | None = None,
        todos: list[dict[str, Any]] | None = None,
        limit: int = 10,
    ) -> dict[str, Any]:
        """Use native Agent Server thread, state, checkpoint history, and todos.

        ``todos_write`` validates the exact canonical
        ``TodoListMiddleware`` schema and stores it in the native thread state;
        ``todos_read`` reads that same state without creating a second planner.
        """

        return capabilities.agent_server.thread(
            action,
            thread_id=thread_id,
            graph_id=graph_id,
            metadata=metadata,
            values=values,
            todos=todos,
            limit=limit,
        )

    @server.tool(annotations=EXECUTION, structured_output=True)
    @instrument("runtime_run")
    def runtime_run(
        action: Literal[
            "create", "resume", "invoke", "get", "join", "list", "events", "cancel"
        ],
        thread_id: str = "",
        assistant_id: str = "",
        run_id: str = "",
        run_input: dict[str, Any] | list[Any] | str | None = None,
        run_command: dict[str, Any] | None = None,
        checkpoint_id: str = "",
        interrupt_before: list[str] | None = None,
        interrupt_after: list[str] | None = None,
        durability: Literal["", "exit", "async", "sync"] = "",
        limit: int = 20,
        stream_mode: str = "values",
    ) -> dict[str, Any]:
        """Use native Agent Server durable runs, interrupts, and resume commands.

        Pass ``run_command`` for native LangGraph ``Command`` payloads such as
        HITL resume decisions. ``run_input`` and ``run_command`` are mutually
        exclusive. ``resume`` creates a new durable continuation run rather
        than replaying the interrupted effect locally.
        """

        return capabilities.agent_server.run(
            action,
            thread_id=thread_id,
            assistant_id=assistant_id,
            run_id=run_id,
            run_input=run_input,
            run_command=run_command,
            checkpoint_id=checkpoint_id,
            interrupt_before=interrupt_before,
            interrupt_after=interrupt_after,
            durability=durability,
            limit=limit,
            stream_mode=stream_mode,
        )

    @server.tool(annotations=EXECUTION, structured_output=True)
    @instrument("runtime_store")
    def runtime_store(
        action: Literal["put", "get", "search", "delete", "list_namespaces"],
        namespace: list[str] | None = None,
        key: str = "",
        value: dict[str, Any] | None = None,
        query: str = "",
        limit: int = 10,
    ) -> dict[str, Any]:
        """Use native Agent Server Store without creating a second state engine."""

        return capabilities.agent_server.store(
            action,
            namespace=namespace,
            key=key,
            value=value,
            query=query,
            limit=limit,
        )

    @server.tool(annotations=EXECUTION, structured_output=True)
    @instrument("specialist_task")
    def specialist_task(
        action: Literal["list", "start", "resume", "status", "result", "cancel"],
        specialist: str = "",
        thread_id: str = "",
        run_id: str = "",
        task: dict[str, Any] | list[Any] | str | None = None,
        run_command: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Optionally use an allowlisted Agent Server specialist.

        ChatGPT remains the main coder and decides whether a bounded specialist
        is useful. No specialist is configured or invoked by default.
        """

        return capabilities.agent_server.specialist(
            action,
            specialist=specialist,
            thread_id=thread_id,
            run_id=run_id,
            task=task,
            run_command=run_command,
        )

    @server.tool(annotations=READ_ONLY, structured_output=True)
    @instrument("observability_status")
    def observability_status() -> dict[str, Any]:
        """Read LangSmith tracing configuration without exposing credentials."""

        return capabilities.observability.status()

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

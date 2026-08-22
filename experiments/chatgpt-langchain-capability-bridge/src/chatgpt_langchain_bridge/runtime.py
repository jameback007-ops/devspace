from __future__ import annotations

from typing import Any

from .agent_server_plane import AgentServerPlane
from .artifact_plane import ArtifactPlane
from .context_plane import ContextPlane
from .observability import ObservabilityPlane
from .process_plane import ProcessPlane
from .registry import WorkspaceRegistry
from .sandbox_plane import SandboxPlane
from .state import Journal


class CapabilityRuntime:
    """Composition root for the WebChat-consumable native capability plane."""

    def __init__(
        self,
        registry: WorkspaceRegistry,
        journal: Journal,
        *,
        context: ContextPlane | None = None,
        artifacts: ArtifactPlane | None = None,
        sandboxes: SandboxPlane | None = None,
        processes: ProcessPlane | None = None,
        agent_server: AgentServerPlane | None = None,
        observability: ObservabilityPlane | None = None,
    ) -> None:
        self.registry = registry
        self.journal = journal
        self.context = context or ContextPlane(registry)
        self.artifacts = artifacts or ArtifactPlane(registry)
        self.sandboxes = sandboxes or SandboxPlane(registry)
        self.processes = processes or ProcessPlane(registry, self.sandboxes)
        self.agent_server = agent_server or AgentServerPlane()
        self.observability = observability or ObservabilityPlane()

    def open_workspace(
        self,
        path: str,
        *,
        target_path: str = ".",
        thread_id: str = "",
    ) -> dict[str, Any]:
        """Open a workspace and return mature-harness-style startup context.

        The bootstrap is a projection only. Native skills/memory and the
        LangGraph/Agent Server journal remain the rightful sources; Git,
        process, test, runtime, and peer state are intentionally not cached.
        """

        workspace = self.registry.open(path)
        bootstrap = self.context.bootstrap(
            workspace["workspace_id"], target_path=target_path
        )
        bootstrap["capability_manifest"] = self.manifest()
        bootstrap["durable_state"] = self._durable_state_pointer(thread_id)
        return {**workspace, "bootstrap": bootstrap}

    def manifest(self) -> dict[str, Any]:
        base = self.registry.capability_manifest()
        base["native_capability_planes"] = {
            "context": self.context.manifest(),
            "artifact_transfer": self.artifacts.manifest(),
            "sandbox": self.sandboxes.manifest(),
            "persistent_process": self.processes.manifest(),
            "agent_server": self.agent_server.manifest(),
            "observability": self.observability.status(),
        }
        base["deep_agents_full_harness_relation"] = {
            "native_execution_backends_reused": True,
            "native_skills_and_memory_reused": True,
            "native_agent_server_runtime_reused": True,
            "native_todo_schema_and_thread_state_reused": True,
            "native_langgraph_interrupt_and_command_resume_reused": True,
            "optional_subagent_seam_available": bool(
                self.agent_server.manifest()["specialist_aliases"]
            ),
            "chatgpt_hidden_system_prompt_replaced": False,
            "chatgpt_hidden_history_auto_summarized": False,
            "deep_agent_model_loop_owns_coding": False,
            "reasoning_and_coding_owner": "chatgpt_webchat",
        }
        return base

    def _durable_state_pointer(self, thread_id: str) -> dict[str, Any]:
        if not thread_id:
            return {
                "state": "not_requested",
                "source": "langgraph_or_agent_server_journal",
                "hint": "pass thread_id to workspace_open when resuming a known mission",
            }

        state = self.journal.read_latest(thread_id)
        latest = state.get("latest") or {}
        allowed_latest_fields = (
            "workspace_id",
            "mission_ref",
            "frontier",
            "next_action",
            "validation_state",
            "refs",
        )
        compact_latest = {
            field: latest[field] for field in allowed_latest_fields if field in latest
        }
        total_event_count = int(state.get("total_event_count", 0))
        return {
            "state": "present" if total_event_count > 0 else "empty",
            "source": state.get("storage", "langgraph_checkpoint"),
            "thread_id": thread_id,
            "checkpoint_id": state.get("checkpoint_id"),
            "event_count": total_event_count,
            "retained_event_count": int(state.get("retained_event_count", 0)),
            "latest": compact_latest or None,
            "authoritative_read": "checkpoint_read",
        }

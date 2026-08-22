from __future__ import annotations

from typing import Any, Mapping

from .agent_server_plane import AgentServerPlane
from .artifact_plane import ArtifactPlane
from .context_plane import ContextPlane
from .durability import DurableMaterialExecutor
from .interaction import InteractionPlane
from .observability import ObservabilityPlane
from .process_plane import ProcessPlane
from .registry import WorkspaceRegistry
from .sandbox_plane import SandboxPlane
from .state import Journal
from .workstream import WorkstreamBindingPlane
from .worktree import WorktreeBindingManager


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
        workstreams: WorkstreamBindingPlane | None = None,
        interactions: InteractionPlane | None = None,
        worktrees: WorktreeBindingManager | None = None,
        material: DurableMaterialExecutor | None = None,
    ) -> None:
        self.registry = registry
        self.journal = journal
        self.context = context or ContextPlane(registry)
        self.artifacts = artifacts or ArtifactPlane(registry)
        self.sandboxes = sandboxes or SandboxPlane(registry)
        self.processes = processes or ProcessPlane(registry, self.sandboxes)
        self.agent_server = agent_server or AgentServerPlane()
        self.observability = observability or ObservabilityPlane()
        self.workstreams = workstreams or WorkstreamBindingPlane(self.agent_server)
        self.interactions = interactions or InteractionPlane(
            registry,
            self.agent_server,
        )
        self.worktrees = worktrees or WorktreeBindingManager.from_environment()
        self.material = material or DurableMaterialExecutor(registry)
        self.observability.set_context_resolver(self._trace_context)

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

        binding = self.workstreams.bind(thread_id)
        if self.worktrees.is_reference(path):
            worktree_binding = self.worktrees.resolve(path, binding.workstream_ref)
            workspace = self.registry.open_worktree(
                worktree_binding,
                workstream=binding,
            )
        else:
            workspace = self.registry.open(path, workstream=binding)
        bootstrap = self.context.bootstrap(
            workspace["workspace_id"], target_path=target_path
        )
        bootstrap["capability_manifest"] = self.manifest()
        bootstrap["workstream"] = binding.public_view()
        bootstrap["peer_updates"] = self.interactions.bootstrap(binding)
        bootstrap["durable_state"] = self._durable_state_pointer(binding.workstream_ref)
        return {**workspace, "bootstrap": bootstrap}

    def write_file(
        self, workspace_id: str, file_path: str, content: str
    ) -> dict[str, Any]:
        return self.material.write_file(workspace_id, file_path, content)

    def edit_file(
        self,
        workspace_id: str,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> dict[str, Any]:
        return self.material.edit_file(
            workspace_id,
            file_path,
            old_string,
            new_string,
            replace_all,
        )

    def delete_file(self, workspace_id: str, file_path: str) -> dict[str, Any]:
        return self.material.delete_file(workspace_id, file_path)

    def manifest(self) -> dict[str, Any]:
        base = self.registry.capability_manifest()
        base["native_capability_planes"] = {
            "context": self.context.manifest(),
            "artifact_transfer": self.artifacts.manifest(),
            "sandbox": self.sandboxes.manifest(),
            "persistent_process": self.processes.manifest(),
            "agent_server": self.agent_server.manifest(),
            "observability": self.observability.status(),
            "workstream_binding": self.workstreams.manifest(),
            "interaction": self.interactions.manifest(),
            "worktree_binding": self.worktrees.manifest(),
            "material_durability": self.material.manifest(),
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

    def _trace_context(
        self, tool_name: str, arguments: Mapping[str, Any]
    ) -> dict[str, Any]:
        workspace_id = str(arguments.get("workspace_id") or "")
        if workspace_id:
            handle = self.registry.get_handle(workspace_id)
            binding = handle.workstream
            if binding is not None:
                return {
                    "thread_id": binding.trace_thread_id,
                    "workstream_ref": binding.workstream_ref,
                    "agent_server_thread_id": binding.agent_thread_id,
                    "interaction_thread_id": binding.interaction_thread_id,
                    "workspace_id": workspace_id,
                    "bridge_reasoning_owner": "chatgpt_webchat",
                }

        raw_thread_id = str(arguments.get("thread_id") or "").strip()
        if raw_thread_id:
            binding = self.registry.workstream_for_agent_thread(raw_thread_id)
            if binding is not None:
                return {
                    "thread_id": binding.trace_thread_id,
                    "workstream_ref": binding.workstream_ref,
                    "agent_server_thread_id": binding.agent_thread_id,
                    "interaction_thread_id": binding.interaction_thread_id,
                    "bridge_reasoning_owner": "chatgpt_webchat",
                }
            if tool_name in {
                "workspace_open",
                "checkpoint_record",
                "checkpoint_read",
            }:
                return {
                    "thread_id": raw_thread_id,
                    "workstream_ref": raw_thread_id,
                    "bridge_reasoning_owner": "chatgpt_webchat",
                }

        return {"bridge_reasoning_owner": "chatgpt_webchat"}

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

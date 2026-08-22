from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

from deepagents.middleware.memory import MemoryMiddleware
from deepagents.middleware.skills import SkillsMiddleware

from .registry import BridgeError, WorkspaceRegistry


@dataclass(frozen=True)
class ContextPlaneConfig:
    """Stable sources for native Deep Agents skills and project memory."""

    skill_source_dirs: tuple[str, ...] = (
        ".agents/skills",
        ".deepagents/skills",
        ".claude/skills",
        "skills",
    )
    max_skill_results: int = 100
    max_bootstrap_instruction_chars: int = 20_000
    max_repository_map_entries: int = 100

    @classmethod
    def from_environment(cls) -> ContextPlaneConfig:
        raw = os.environ.get("BRIDGE_SKILL_SOURCE_DIRS", "").strip()
        if raw:
            sources = tuple(
                item.strip().strip("/")
                for item in raw.split(os.pathsep)
                if item.strip().strip("/")
            )
        else:
            sources = cls().skill_source_dirs
        return cls(
            skill_source_dirs=sources,
            max_skill_results=int(os.environ.get("BRIDGE_MAX_SKILL_RESULTS", "100")),
            max_bootstrap_instruction_chars=int(
                os.environ.get("BRIDGE_MAX_BOOTSTRAP_INSTRUCTION_CHARS", "20000")
            ),
            max_repository_map_entries=int(
                os.environ.get("BRIDGE_MAX_REPOSITORY_MAP_ENTRIES", "100")
            ),
        )


class ContextPlane:
    """Expose native SkillsMiddleware and MemoryMiddleware to WebChat.

    Deep Agents normally injects these values into its own model request. The
    bridge deliberately does not own ChatGPT's hidden model loop, so it exposes
    the same native metadata/content through explicit MCP reads instead.
    """

    def __init__(
        self,
        registry: WorkspaceRegistry,
        config: ContextPlaneConfig | None = None,
    ) -> None:
        self._registry = registry
        self._config = config or ContextPlaneConfig.from_environment()

    def manifest(self) -> dict[str, Any]:
        return {
            "state": "available",
            "native_components": [
                "deepagents.middleware.SkillsMiddleware",
                "deepagents.middleware.MemoryMiddleware",
            ],
            "skill_source_dirs": list(self._config.skill_source_dirs),
            "webchat_projection": "explicit_progressive_disclosure",
            "model_loop_boundaries": {
                "hidden_system_prompt_injection": False,
                "automatic_webchat_history_summarization": False,
                "deep_agent_prompt_middleware_applied_to_webchat": False,
            },
            "selection_policy": (
                "native metadata order with optional literal query filtering; "
                "no custom ranking engine"
            ),
        }

    def bootstrap(self, workspace_id: str, target_path: str = ".") -> dict[str, Any]:
        """Build the bounded automatic workspace-open context projection.

        This is the unique WebChat adapter seam: mature harnesses can inject
        startup context directly, while MCP can only return it as a tool result.
        All source material remains owned by the native backend and is read
        fresh for this open/attach operation.
        """

        discovered = self.discover(
            workspace_id,
            query="",
            target_path=target_path,
            limit=self._config.max_skill_results,
        )
        remaining = self._config.max_bootstrap_instruction_chars
        instructions: list[dict[str, Any]] = []
        for item in discovered["memory"]:
            if remaining <= 0:
                break
            result = self._registry.read(workspace_id, item["path"], 0, 2000)
            content = str(result.get("file_data", {}).get("content", ""))
            bounded = content[:remaining]
            remaining -= len(bounded)
            instructions.append(
                {
                    "path": item["path"],
                    "content": bounded,
                    "truncated": len(bounded) < len(content),
                    "native_source": item["native_source"],
                }
            )

        repository_listing = self._registry.ls(workspace_id, ".")
        repository_entries = repository_listing.get("entries", [])
        map_entries = []
        for entry in repository_entries[: self._config.max_repository_map_entries]:
            map_entries.append(
                {
                    "path": self._registry.display_backend_path(
                        workspace_id, str(entry["path"])
                    ),
                    "is_dir": bool(entry.get("is_dir")),
                    "size": int(entry.get("size", 0)),
                }
            )

        return {
            "schema_version": "chatgpt-langchain-workspace-bootstrap.v1",
            "target_path": self._clean_relative_path(target_path),
            "instructions": instructions,
            "instruction_scope": {
                "mode": "root_to_target_hierarchical_lazy",
                "loaded_paths": [item["path"] for item in instructions],
                "reload_when_target_changes": True,
            },
            "skills": discovered["skills"],
            "skills_progressive_disclosure": discovered["progressive_disclosure"],
            "repository_map": {
                "source": "native_backend_top_level_ls",
                "entries": map_entries,
                "truncated": len(repository_entries) > len(map_entries),
            },
            "fresh_state_policy": {
                "git": "read_from_git_when_needed",
                "tests": "run_when_needed",
                "processes": "read_from_process_provider_when_needed",
                "agent_runtime": "read_from_agent_server_when_needed",
                "peer_state": "read_from_rightful_peer_source_when_needed",
            },
            "model_loop_boundaries": discovered["model_loop_boundaries"],
        }

    def discover(
        self,
        workspace_id: str,
        query: str = "",
        target_path: str = ".",
        limit: int = 50,
    ) -> dict[str, Any]:
        handle = self._registry.get_handle(workspace_id)
        candidate_skill_sources = [
            self._registry.normalize_file_path(workspace_id, source)
            for source in self._config.skill_source_dirs
        ]
        skill_sources = [
            source
            for source in candidate_skill_sources
            if handle.backend.ls(source).error is None
        ]
        skills_middleware = SkillsMiddleware(
            backend=handle.backend,
            sources=skill_sources,
            system_prompt=None,
        )
        skill_update = skills_middleware.before_agent(  # type: ignore[arg-type]
            {}, None, {}
        ) or {"skills_metadata": []}
        skills = [
            self._public_skill(workspace_id, item)
            for item in skill_update.get("skills_metadata", [])
        ]
        skills = self._select_skills(skills, query)[: self._bounded_limit(limit)]

        memory_sources = self._memory_sources(workspace_id, target_path)
        memory_middleware = MemoryMiddleware(
            backend=handle.backend,
            sources=memory_sources,
            system_prompt=None,
        )
        memory_update = memory_middleware.before_agent(  # type: ignore[arg-type]
            {}, None, {}
        ) or {"memory_contents": {}}
        memory = []
        for backend_path, content in memory_update.get("memory_contents", {}).items():
            encoded = content.encode("utf-8")
            memory.append(
                {
                    "kind": "memory",
                    "path": self._registry.display_backend_path(
                        workspace_id, backend_path
                    ),
                    "byte_count": len(encoded),
                    "sha256": hashlib.sha256(encoded).hexdigest(),
                    "native_source": "deepagents.middleware.MemoryMiddleware",
                }
            )

        return {
            "schema_version": "chatgpt-langchain-context-plane.v1",
            "workspace_id": workspace_id,
            "target_path": self._clean_relative_path(target_path),
            "skills": skills,
            "memory": memory,
            "skill_load_errors": skill_update.get("skills_load_errors", []),
            "progressive_disclosure": {
                "metadata_loaded_first": True,
                "read_full_content_with": "context_read",
            },
            "model_loop_boundaries": self.manifest()["model_loop_boundaries"],
        }

    def read(
        self,
        workspace_id: str,
        context_kind: str,
        path: str,
        offset: int = 0,
        limit: int = 400,
    ) -> dict[str, Any]:
        clean_path = self._clean_relative_path(path)
        if context_kind == "skill":
            if PurePosixPath(clean_path).name != "SKILL.md":
                raise BridgeError("skill context must reference a SKILL.md file")
            if not any(
                self._is_under(clean_path, source)
                for source in self._config.skill_source_dirs
            ):
                raise BridgeError("skill context is outside configured skill sources")
        elif context_kind == "memory":
            if PurePosixPath(clean_path).name != "AGENTS.md":
                raise BridgeError("memory context must reference an AGENTS.md file")
        else:
            raise BridgeError("context_kind must be 'skill' or 'memory'")

        result = self._registry.read(
            workspace_id,
            clean_path,
            offset=max(0, offset),
            limit=max(1, min(limit, 2000)),
        )
        return {
            "schema_version": "chatgpt-langchain-context-read.v1",
            "kind": context_kind,
            "path": clean_path,
            "native_backend_result": result,
        }

    def _memory_sources(self, workspace_id: str, target_path: str) -> list[str]:
        clean = self._clean_relative_path(target_path)
        path = self._target_directory(workspace_id, clean)

        candidates = [PurePosixPath("AGENTS.md")]
        current = PurePosixPath()
        for part in path.parts:
            if part in {"", "."}:
                continue
            current /= part
            candidates.append(current / "AGENTS.md")

        unique: list[str] = []
        seen: set[str] = set()
        for candidate in candidates:
            relative = candidate.as_posix()
            if relative in seen:
                continue
            seen.add(relative)
            unique.append(self._registry.normalize_file_path(workspace_id, relative))
        return unique

    def _target_directory(
        self, workspace_id: str, clean_target_path: str
    ) -> PurePosixPath:
        target = PurePosixPath(clean_target_path)
        if clean_target_path == ".":
            return PurePosixPath()

        parent = target.parent
        parent_path = parent.as_posix() if parent.as_posix() not in {"", "."} else "."
        listing = self._registry.ls(workspace_id, parent_path)
        for entry in listing.get("entries", []):
            visible = self._registry.display_backend_path(
                workspace_id, str(entry["path"])
            )
            if visible == target.as_posix():
                return target if bool(entry.get("is_dir")) else parent

        # A missing target contributes no nested AGENTS.md yet. Treat its parent
        # as the current instruction scope instead of asking native memory
        # middleware to download an invalid file/AGENTS.md path.
        return parent

    def _public_skill(
        self, workspace_id: str, metadata: dict[str, Any]
    ) -> dict[str, Any]:
        return {
            "kind": "skill",
            "path": self._registry.display_backend_path(workspace_id, metadata["path"]),
            "name": metadata["name"],
            "description": metadata["description"],
            "license": metadata.get("license"),
            "compatibility": metadata.get("compatibility"),
            "metadata": metadata.get("metadata", {}),
            "allowed_tools": metadata.get("allowed_tools", []),
            "native_source": "deepagents.middleware.SkillsMiddleware",
        }

    def _select_skills(
        self, skills: list[dict[str, Any]], query: str
    ) -> list[dict[str, Any]]:
        terms = [term for term in query.casefold().split() if term]
        if not terms:
            return skills

        selected: list[dict[str, Any]] = []
        for item in skills:
            haystack = " ".join(
                [
                    str(item["name"]).casefold(),
                    str(item["description"]).casefold(),
                    str(item.get("compatibility") or "").casefold(),
                    " ".join(item.get("allowed_tools", [])).casefold(),
                ]
            )
            if all(term in haystack for term in terms):
                selected.append(item)
        return selected

    def _bounded_limit(self, limit: int) -> int:
        return max(1, min(limit, self._config.max_skill_results))

    @staticmethod
    def _clean_relative_path(path: str) -> str:
        candidate = PurePosixPath(path or ".")
        if candidate.is_absolute() or ".." in candidate.parts:
            raise BridgeError("context path must be workspace-relative")
        rendered = candidate.as_posix()
        if rendered.startswith("./"):
            rendered = rendered[2:]
        return rendered or "."

    @staticmethod
    def _is_under(path: str, parent: str) -> bool:
        candidate = PurePosixPath(path)
        base = PurePosixPath(parent.strip("/"))
        try:
            candidate.relative_to(base)
        except ValueError:
            return False
        return True

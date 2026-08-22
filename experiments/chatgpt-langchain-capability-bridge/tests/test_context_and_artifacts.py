from __future__ import annotations

import base64
from pathlib import Path

import pytest

from chatgpt_langchain_bridge.artifact_plane import ArtifactPlane
from chatgpt_langchain_bridge.context_plane import ContextPlane
from chatgpt_langchain_bridge.registry import (
    BridgeConfig,
    BridgeError,
    WorkspaceRegistry,
)
from chatgpt_langchain_bridge.runtime import CapabilityRuntime
from chatgpt_langchain_bridge.state import CheckpointJournal


def make_registry(
    root: Path, *, max_transfer_bytes: int = 4_000_000
) -> tuple[WorkspaceRegistry, str]:
    registry = WorkspaceRegistry(
        BridgeConfig(
            allowed_roots=(root.resolve(),),
            max_transfer_bytes=max_transfer_bytes,
        )
    )
    workspace_id = registry.open(str(root))["workspace_id"]
    return registry, workspace_id


def test_native_skills_and_agents_memory_are_progressively_disclosed(
    tmp_path: Path,
) -> None:
    skill_dir = tmp_path / ".agents" / "skills" / "zes-coding"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: zes-coding\n"
        "description: Native coding workflow\n"
        "allowed-tools: read_file edit_file execute\n"
        "---\n"
        "# ZES coding\n"
        "Read before editing.\n",
        encoding="utf-8",
    )
    (tmp_path / "src").mkdir()
    (tmp_path / "AGENTS.md").write_text("# Root\nValidate changes.\n", encoding="utf-8")
    (tmp_path / "src" / "AGENTS.md").write_text(
        "# Source\nUse native backends.\n", encoding="utf-8"
    )

    registry, workspace_id = make_registry(tmp_path)
    plane = ContextPlane(registry)
    discovered = plane.discover(
        workspace_id,
        query="coding",
        target_path="src/module.py",
    )

    assert [item["name"] for item in discovered["skills"]] == ["zes-coding"]
    assert [item["path"] for item in discovered["memory"]] == [
        "AGENTS.md",
        "src/AGENTS.md",
    ]
    assert discovered["progressive_disclosure"]["metadata_loaded_first"] is True
    assert discovered["model_loop_boundaries"] == {
        "hidden_system_prompt_injection": False,
        "automatic_webchat_history_summarization": False,
        "deep_agent_prompt_middleware_applied_to_webchat": False,
    }

    skill = plane.read(
        workspace_id,
        "skill",
        discovered["skills"][0]["path"],
    )
    assert (
        "Read before editing" in skill["native_backend_result"]["file_data"]["content"]
    )

    memory = plane.read(workspace_id, "memory", "src/AGENTS.md")
    assert (
        "Use native backends" in memory["native_backend_result"]["file_data"]["content"]
    )


def test_context_read_rejects_unregistered_skill_path(tmp_path: Path) -> None:
    (tmp_path / "other").mkdir()
    (tmp_path / "other" / "SKILL.md").write_text(
        "---\nname: other\ndescription: other\n---\n",
        encoding="utf-8",
    )
    registry, workspace_id = make_registry(tmp_path)

    with pytest.raises(BridgeError, match="outside configured skill sources"):
        ContextPlane(registry).read(workspace_id, "skill", "other/SKILL.md")


def test_workspace_open_returns_bounded_native_bootstrap(tmp_path: Path) -> None:
    skill_dir = tmp_path / ".agents" / "skills" / "native-first"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: native-first\n"
        "description: Prefer mature native capabilities\n"
        "---\n"
        "# Native first\n"
        "This full body must stay lazy.\n",
        encoding="utf-8",
    )
    (tmp_path / "packages" / "core").mkdir(parents=True)
    (tmp_path / "AGENTS.md").write_text("# Root\nRoot invariant.\n", encoding="utf-8")
    (tmp_path / "packages" / "AGENTS.md").write_text(
        "# Packages\nPackage invariant.\n", encoding="utf-8"
    )
    (tmp_path / "packages" / "core" / "AGENTS.md").write_text(
        "# Core\nCore invariant.\n", encoding="utf-8"
    )
    (tmp_path / "pyproject.toml").write_text("[project]\nname='fixture'\n")

    registry, workspace_id = make_registry(tmp_path)
    journal = CheckpointJournal(tmp_path / "state.sqlite")
    try:
        journal.record(
            "mission-1",
            {
                "workspace_id": workspace_id,
                "mission_ref": "mission:bootstrap",
                "frontier": "context ready",
                "next_action": "inspect source",
                "validation_state": "not_run",
                "secret_like_extra": "must not be projected",
            },
        )
        opened = CapabilityRuntime(registry, journal).open_workspace(
            str(tmp_path),
            target_path="packages/core/module.py",
            thread_id="mission-1",
        )
    finally:
        journal.close()

    bootstrap = opened["bootstrap"]
    assert [item["path"] for item in bootstrap["instructions"]] == [
        "AGENTS.md",
        "packages/AGENTS.md",
        "packages/core/AGENTS.md",
    ]
    assert "Root invariant" in bootstrap["instructions"][0]["content"]
    assert bootstrap["skills"][0]["name"] == "native-first"
    assert "content" not in bootstrap["skills"][0]
    assert bootstrap["capability_manifest"]["reasoning_owner"] == "chatgpt_webchat"
    assert bootstrap["durable_state"]["event_count"] == 1
    assert bootstrap["durable_state"]["latest"] == {
        "workspace_id": workspace_id,
        "mission_ref": "mission:bootstrap",
        "frontier": "context ready",
        "next_action": "inspect source",
        "validation_state": "not_run",
    }
    assert "events" not in bootstrap["durable_state"]
    assert all(
        "modified_at" not in item for item in bootstrap["repository_map"]["entries"]
    )
    assert bootstrap["instruction_scope"]["reload_when_target_changes"] is True


def test_skill_query_preserves_native_metadata_order(tmp_path: Path) -> None:
    for name, description in (
        ("z-last", "coding native first"),
        ("a-first", "coding native second"),
    ):
        directory = tmp_path / ".agents" / "skills" / name
        directory.mkdir(parents=True)
        (directory / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: {description}\n---\n",
            encoding="utf-8",
        )
    registry, workspace_id = make_registry(tmp_path)

    plane = ContextPlane(registry)
    native_order = [
        item["name"] for item in plane.discover(workspace_id, query="")["skills"]
    ]
    filtered_order = [
        item["name"]
        for item in plane.discover(workspace_id, query="coding native")["skills"]
    ]

    assert filtered_order == native_order


def test_artifact_transfer_uses_native_backend_and_preserves_binary(
    tmp_path: Path,
) -> None:
    registry, workspace_id = make_registry(tmp_path)
    plane = ArtifactPlane(registry)
    content = b"\x00native-artifact\xff"

    uploaded = plane.transfer(
        workspace_id,
        "upload",
        "artifacts/result.bin",
        base64.b64encode(content).decode("ascii"),
    )
    downloaded = plane.transfer(
        workspace_id,
        "download",
        "artifacts/result.bin",
    )

    assert uploaded["native_backend_result"]["error"] is None
    assert base64.b64decode(downloaded["content_base64"]) == content
    assert uploaded["sha256"] == downloaded["sha256"]


def test_artifact_transfer_enforces_size_ceiling(tmp_path: Path) -> None:
    registry, workspace_id = make_registry(tmp_path, max_transfer_bytes=4)

    with pytest.raises(BridgeError, match="BRIDGE_MAX_TRANSFER_BYTES"):
        ArtifactPlane(registry).transfer(
            workspace_id,
            "upload",
            "large.bin",
            base64.b64encode(b"12345").decode("ascii"),
        )

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, value = line.split("=", 1)
        values[key] = value
    return values


def test_production_template_is_fail_closed_and_secret_free() -> None:
    values = parse_env_file(ROOT / ".env.agent-server.production.example")

    assert values["LANGGRAPH_CLOUD_LICENSE_KEY"] == ""
    assert values["LANGSMITH_API_KEY"] == ""
    assert values["DATABASE_URI"] == ""
    assert values["REDIS_URI"] == ""
    assert values["LANGGRAPH_AES_KEY"] == ""
    assert values["LANGSMITH_ENDPOINT"] == "https://apac.api.smith.langchain.com"
    assert values["LANGGRAPH_SERVER_HOST"] == "0.0.0.0"
    assert values["PORT"] == "8000"

    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    dockerignore = (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
    for secret_path in (
        ".env.agent-server.production",
        ".env.agent-server.production.local",
    ):
        assert secret_path in gitignore
        assert secret_path in dockerignore
    assert "*.secret.env" in gitignore
    assert "*.secret.env" in dockerignore


def test_native_config_and_readiness_gate_do_not_claim_production() -> None:
    config = json.loads((ROOT / "langgraph.json").read_text(encoding="utf-8"))
    evidence = json.loads(
        (
            ROOT / "evidence" / "native-agent-server-production-readiness-20260822.json"
        ).read_text(encoding="utf-8")
    )

    assert "$schema" not in config
    assert sorted(config["graphs"]) == ["bridge_hitl", "bridge_journal"]
    assert evidence["status"] == "activation_held"
    assert (
        evidence["authority_and_credentials"]["langgraph_cloud_license_key_present"]
        is False
    )
    assert evidence["authority_and_credentials"]["database_uri_present"] is False
    assert evidence["authority_and_credentials"]["redis_uri_present"] is False
    assert evidence["current_runtime"]["production_claimed"] is False
    assert evidence["runtime_mutated"] is False
    assert evidence["services_started"] is False


def test_production_compose_override_is_only_a_thin_private_binding() -> None:
    overlay = (
        ROOT / "compose.agent-server.production.override.yaml"
    ).read_text(encoding="utf-8")

    assert "127.0.0.1:${LANGGRAPH_HOST_PORT:-2027}:8000" in overlay
    assert "${LANGGRAPH_BRIDGE_ENV_FILE:?Set LANGGRAPH_BRIDGE_ENV_FILE}" in overlay
    assert (
        "${LANGGRAPH_PRODUCTION_ENV_FILE:?Set LANGGRAPH_PRODUCTION_ENV_FILE}"
        in overlay
    )
    assert "langgraph-postgres:" in overlay
    assert "ports: !override []" in overlay
    assert "langgraph-redis:" not in overlay
    assert "image:" not in overlay
    assert "command:" not in overlay
    assert "volumes:" not in overlay
    assert "environment:" not in overlay

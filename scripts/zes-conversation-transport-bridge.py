#!/usr/bin/env python3
"""Bounded direct-first conversation transport bridge for DevSpace.

The bridge owns privileged access to the local Codex App Server. Callers use
fixed target aliases; arbitrary thread ids, socket paths, browser URLs, and
credentials are never accepted over the bridge socket. Delivery metadata is
persisted before dispatch, while prompt text is kept only in memory.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import socketserver
import sqlite3
import struct
import sys
import threading
from typing import Any
from urllib.parse import urlsplit, urlunsplit


DEFAULT_CONFIG = Path("/etc/zes-conversation-transport-bridge.json")
DEFAULT_SOCKET = Path("/run/zes-conversation-transport-bridge/bridge.sock")
MAX_REQUEST_BYTES = 256 * 1024
MAX_PROMPT_CHARACTERS = 12_000
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
ALIAS_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$")
REF_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,999}$")
WAKE_ELIGIBLE_LIFECYCLES = {
    "idle",
    "responsiveidle",
    "awaitinginput",
    "ready",
    "completed",
    "succeeded",
    "success",
    "done",
    "taskcomplete",
    "failed",
    "error",
    "systemerror",
    "terminalerror",
    "cancelled",
    "canceled",
    "interrupted",
    "aborted",
}

AUTHORITY = {
    "authority": "bounded_privileged_conversation_transport_bridge",
    "canonicalTaskAuthority": False,
    "canonicalDecisionAuthority": False,
    "writerLeaseAuthority": False,
    "publicationAuthority": False,
    "arbitraryThreadIdAccepted": False,
    "arbitrarySocketPathAccepted": False,
    "rawConversationUrlPersisted": False,
    "rawPromptPersisted": False,
    "codexNativeLaneWrapped": False,
    "genericCodexRpcAccepted": False,
    "reconcileBeforeRetry": True,
    "unknownFailsClosed": True,
}


class BridgeError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        retry_disposition: str = "safe_after_correction",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retry_disposition = retry_disposition


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value: str | bytes) -> str:
    payload = value if isinstance(value, bytes) else value.encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def digest_ref(prefix: str, *values: str) -> str:
    return f"{prefix}:{sha256(canonical_json(list(values)))}"


def wake_eligible_session_lifecycle(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    normalized = re.sub(r"[^a-z0-9]+", "", value.strip().lower())
    return normalized in WAKE_ELIGIBLE_LIFECYCLES


def require_string(
    value: Any,
    name: str,
    *,
    maximum: int = 2_000,
    pattern: re.Pattern[str] | None = None,
) -> str:
    if not isinstance(value, str):
        raise BridgeError("INVALID_REQUEST", f"{name} must be a string")
    result = value.strip()
    if not result or len(result) > maximum:
        raise BridgeError("INVALID_REQUEST", f"{name} is empty or too long")
    if pattern is not None and not pattern.fullmatch(result):
        raise BridgeError("INVALID_REQUEST", f"{name} has an invalid format")
    return result


def require_sha256(value: Any, name: str) -> str:
    return require_string(value, name, maximum=64, pattern=SHA256_PATTERN)


def normalize_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise BridgeError("WEB_UI_URL_INVALID", "Browser target did not return an HTTP(S) URL")
    path = parsed.path.rstrip("/") or "/"
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), path, "", ""))


def load_python_module(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise BridgeError("RELAY_MODULE_UNAVAILABLE", "Unable to load relay module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_target(target_alias: str, raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise BridgeError("CONFIG_INVALID", f"Target {target_alias} must be an object")
    target_kind = raw.get("targetKind")
    if target_kind not in {"codex_thread", "chatgpt_chat", "chatgpt_work", "generic"}:
        raise BridgeError("CONFIG_INVALID", f"Target {target_alias} has an invalid targetKind")
    binding_generation = raw.get("bindingGeneration", 1)
    if not isinstance(binding_generation, int) or binding_generation < 1:
        raise BridgeError("CONFIG_INVALID", f"Target {target_alias} has invalid bindingGeneration")
    native = raw.get("native")
    if native is not None:
        if not isinstance(native, dict) or not isinstance(native.get("threadId"), str):
            raise BridgeError("CONFIG_INVALID", f"Target {target_alias} native.threadId is required")
    web_ui = raw.get("webUi")
    if web_ui is not None:
        required = [
            "mcpThreadId",
            "expectedOrigin",
            "conversationUrlDigestSha256",
            "bindingAttestedAt",
            "bindingExpiresAt",
        ]
        if not isinstance(web_ui, dict) or any(not isinstance(web_ui.get(key), str) for key in required):
            raise BridgeError("CONFIG_INVALID", f"Target {target_alias} webUi binding is incomplete")
        require_sha256(web_ui["conversationUrlDigestSha256"], "conversationUrlDigestSha256")
        for key in ("bindingAttestedAt", "bindingExpiresAt"):
            try:
                dt.datetime.fromisoformat(web_ui[key].replace("Z", "+00:00"))
            except ValueError as exc:
                raise BridgeError("CONFIG_INVALID", f"Target {target_alias} {key} is invalid") from exc
    return {
        **raw,
        "targetAlias": target_alias,
        "targetKind": target_kind,
        "bindingGeneration": binding_generation,
    }


def load_config(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BridgeError("CONFIG_UNAVAILABLE", "Bridge configuration could not be loaded") from exc
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
        raise BridgeError("CONFIG_INVALID", "Bridge configuration schemaVersion must be 1")
    targets_raw = raw.get("targets")
    if not isinstance(targets_raw, dict) or not targets_raw:
        raise BridgeError("CONFIG_INVALID", "Bridge configuration requires targets")
    targets: dict[str, dict[str, Any]] = {}
    for alias, target in targets_raw.items():
        alias = require_string(alias, "target alias", maximum=200, pattern=ALIAS_PATTERN)
        targets[alias] = validate_target(alias, target)
    relay_path = Path(raw.get("relayModulePath", "/root/.codex/skills/codex-thread-relay/scripts/codex_thread_relay.py"))
    app_server_socket = Path(raw.get("appServerSocket", "/root/.codex/app-server-control/app-server-control.sock"))
    state_dir = Path(raw.get("stateDir", "/var/lib/zes-conversation-transport-bridge"))
    socket_path = Path(raw.get("socketPath", str(DEFAULT_SOCKET)))
    codex_gateway_module_path = Path(
        raw.get(
            "codexGatewayModulePath",
            str(Path(__file__).with_name("zes_codex_gateway.py")),
        )
    )
    allowed_peer_uids = raw.get("allowedPeerUids", [0])
    if not isinstance(allowed_peer_uids, list) or any(not isinstance(uid, int) or uid < 0 for uid in allowed_peer_uids):
        raise BridgeError("CONFIG_INVALID", "allowedPeerUids must be non-negative integers")
    return {
        **raw,
        "targets": targets,
        "relayModulePath": relay_path,
        "appServerSocket": app_server_socket,
        "stateDir": state_dir,
        "socketPath": socket_path,
        "codexGatewayModulePath": codex_gateway_module_path,
        "allowedPeerUids": set(allowed_peer_uids),
    }


def open_ledger(state_dir: Path) -> sqlite3.Connection:
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(state_dir, 0o700)
    path = state_dir / "bridge.sqlite3"
    path.touch(mode=0o600, exist_ok=True)
    os.chmod(path, 0o600)
    connection = sqlite3.connect(path, timeout=10.0)
    connection.execute("pragma journal_mode = WAL")
    connection.execute("pragma synchronous = FULL")
    connection.execute(
        """
        create table if not exists deliveries (
          delivery_ref text primary key,
          permit_ref text not null,
          target_alias text not null,
          target_ref_digest_sha256 text not null,
          binding_ref text not null,
          binding_generation integer not null,
          transport_id text not null,
          transport_kind text not null,
          route_digest_sha256 text not null,
          message_id text not null unique,
          prompt_digest_sha256 text not null,
          conversation_url_digest_sha256 text,
          state text not null,
          turn_ref text,
          item_ref text,
          generation_boundary_ref_after text,
          failure_code text,
          attempts integer not null default 0,
          created_at text not null,
          updated_at text not null,
          unique(permit_ref, transport_id)
        )
        """
    )
    columns = {
        row[1]
        for row in connection.execute("pragma table_info(deliveries)").fetchall()
    }
    if "conversation_url_digest_sha256" not in columns:
        connection.execute(
            "alter table deliveries add column conversation_url_digest_sha256 text"
        )
    return connection


class Bridge:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.relay = load_python_module(config["relayModulePath"], "zes_codex_thread_relay")
        codex_gateway_module_path = config.get(
            "codexGatewayModulePath",
            Path(__file__).with_name("zes_codex_gateway.py"),
        )
        self.codex_gateway_module = load_python_module(
            Path(codex_gateway_module_path),
            "zes_codex_gateway",
        )
        try:
            self.codex_gateway = self.codex_gateway_module.CodexGateway(
                config,
                self.relay,
            )
        except self.codex_gateway_module.GatewayError as exc:
            raise BridgeError(
                exc.code,
                str(exc),
                exc.retry_disposition,
            ) from exc
        self._lock_path = config["stateDir"] / "bridge.lock"
        self._lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

    def handle_codex_gateway(self, request: dict[str, Any]) -> dict[str, Any]:
        try:
            return self.codex_gateway.handle(request)
        except self.codex_gateway_module.GatewayError as exc:
            raise BridgeError(
                exc.code,
                str(exc),
                exc.retry_disposition,
            ) from exc

    def close(self) -> None:
        gateway = getattr(self, "codex_gateway", None)
        if gateway is not None:
            gateway.close()

    def target(self, alias: str) -> dict[str, Any]:
        alias = require_string(alias, "targetAlias", maximum=200, pattern=ALIAS_PATTERN)
        target = self.config["targets"].get(alias)
        if target is None:
            raise BridgeError("TARGET_ALIAS_NOT_ALLOWLISTED", "Target alias is not configured", "forbidden")
        return target

    def rpc(self) -> Any:
        app_server_socket: Path = self.config["appServerSocket"]
        if not app_server_socket.is_socket():
            raise BridgeError("APP_SERVER_UNAVAILABLE", "Codex App Server socket is unavailable")
        return self.relay.UnixWebSocketRpc(app_server_socket, float(self.config.get("timeoutSeconds", 20)))

    def status(self, alias: str) -> dict[str, Any]:
        target = self.target(alias)
        observed_at = utc_now()
        expires_at = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=30)).isoformat(timespec="milliseconds")
        target_digest = sha256(canonical_json(target))
        candidates: list[dict[str, Any]] = []
        limitations: list[str] = []
        evidence_refs = [
            f"bridge-target-sha256:{target_digest}",
            "bridge-protocol:v1",
        ]
        try:
            with self.rpc() as rpc:
                initialized = rpc.initialize()
                evidence_refs.append(
                    f"app-server-user-agent-sha256:{sha256(str(initialized.get('userAgent', 'unknown')))}"
                )
                native_candidate, native_limitations = self._native_status(rpc, target)
                candidates.append(native_candidate)
                limitations.extend(native_limitations)
                web_candidate, web_limitations, web_evidence = self._web_ui_status(rpc, target)
                if web_candidate is not None:
                    candidates.append(web_candidate)
                limitations.extend(web_limitations)
                evidence_refs.extend(web_evidence)
        except BridgeError as exc:
            limitations.append(exc.code)
            candidates.extend(self._unavailable_candidates(target, exc.code))
        evidence_refs = sorted(set(evidence_refs))
        evidence_digest = sha256(canonical_json({
            "candidates": candidates,
            "limitations": sorted(set(limitations)),
            "evidenceRefs": evidence_refs,
        }))
        return {
            "schemaVersion": 1,
            "targetAlias": alias,
            "targetKind": target["targetKind"],
            "targetRefDigestSha256": target_digest,
            "bindingRef": target.get("bindingRef", f"bridge-target:{alias}"),
            "bindingGeneration": target["bindingGeneration"],
            "candidates": candidates,
            "observedAt": observed_at,
            "expiresAt": expires_at,
            "evidenceDigestSha256": evidence_digest,
            "evidenceRefs": evidence_refs,
            "limitationCodes": sorted(set(limitations)),
            "authority": AUTHORITY,
        }

    def _native_status(self, rpc: Any, target: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        transport_id = f"codex-app-server:{target['targetAlias']}"
        native = target.get("native")
        if target["targetKind"] != "codex_thread" or not isinstance(native, dict):
            limitation = "UPSTREAM_CHAT_WORK_NATIVE_CONTROL_PROTOCOL_UNATTESTED" if target["targetKind"] in {"chatgpt_chat", "chatgpt_work"} else "NATIVE_TARGET_NOT_CONFIGURED"
            return self._candidate(
                target,
                transport_id,
                "native_rpc",
                availability="unavailable",
                health="unavailable",
                direct_input="unavailable",
                binding="unknown",
                reconciliation="unavailable",
                surface_trust="official",
                lifecycle="not_observed",
                evidence=[f"limitation:{limitation}"],
            ), [limitation]
        try:
            thread = rpc.request(
                "thread/read",
                {"threadId": native["threadId"], "includeTurns": False},
            )["thread"]
        except BaseException as exc:
            code = "CODEX_THREAD_UNAVAILABLE"
            return self._candidate(
                target,
                transport_id,
                "native_rpc",
                availability="unavailable",
                health="unavailable",
                direct_input="unknown",
                binding="unknown",
                reconciliation="available",
                surface_trust="official",
                lifecycle="not_observed",
                evidence=[f"native-read-error-sha256:{sha256(type(exc).__name__)}"],
            ), [code]
        exact = thread.get("id") == native["threadId"]
        # App Server's generated Thread schema does not expose a separate
        # canAcceptDirectInput field. Exact thread/read identity plus the
        # attested turn/start and turn/steer protocol is the direct-input
        # capability boundary; lifecycle errors do not collapse transport
        # health when the thread itself remains addressable.
        direct = exact
        lifecycle = str((thread.get("status") or {}).get("type", "unknown"))
        evidence = [
            "codex-app-server:thread-read",
            "codex-app-server:client-user-message-id",
            f"codex-thread-ref-sha256:{sha256(str(thread.get('id', '')))}",
        ]
        return self._candidate(
            target,
            transport_id,
            "native_rpc",
            availability="available" if exact and direct else "unavailable",
            health="healthy" if exact else "degraded",
            direct_input="available" if direct else "unavailable",
            binding="exact" if exact else "mismatch",
            reconciliation="available",
            surface_trust="official",
            lifecycle=lifecycle,
            evidence=evidence,
        ), [] if exact and direct else ["CODEX_DIRECT_INPUT_UNAVAILABLE"]

    def _web_ui_status(
        self,
        rpc: Any,
        target: dict[str, Any],
    ) -> tuple[dict[str, Any] | None, list[str], list[str]]:
        web = target.get("webUi")
        if not isinstance(web, dict):
            return None, ["WEB_UI_BINDING_NOT_CONFIGURED"], []
        transport_id = f"app-server-mcp-playwright:{target['targetAlias']}"
        evidence: list[str] = ["playwright-route:app-server-mcp-tool-call"]
        limitations: list[str] = []
        try:
            status = rpc.request(
                "mcpServerStatus/list",
                {
                    "detail": "toolsAndAuthOnly",
                    "limit": 100,
                    "threadId": web["mcpThreadId"],
                },
            )
            server_name = web.get("server", "playwright")
            server = next(
                (item for item in status.get("data", []) if item.get("name") == server_name),
                None,
            )
            tools = set((server or {}).get("tools", {}).keys())
            required = {"browser_evaluate", "browser_wait_for"}
            tools_ready = server is not None and required.issubset(tools)
            evidence.append(f"playwright-tool-surface-sha256:{sha256(canonical_json(sorted(tools)))}")
        except BaseException as exc:
            tools_ready = False
            evidence.append(f"playwright-status-error-sha256:{sha256(type(exc).__name__)}")
        binding_valid = self._binding_time_valid(web)
        observation: dict[str, Any] | None = None
        if tools_ready and binding_valid:
            try:
                observation = self._observe_web_ui(rpc, web)
                evidence.append(f"web-ui-observation-sha256:{sha256(canonical_json(observation))}")
            except BaseException as exc:
                limitations.append("WEB_UI_OBSERVATION_FAILED")
                evidence.append(f"web-ui-observation-error-sha256:{sha256(type(exc).__name__)}")
        exact = bool(observation and observation.get("bindingExact"))
        actionable = bool(
            exact
            and observation.get("visible")
            and observation.get("composerCount") == 1
            and observation.get("composerEmpty")
            and observation.get("submitCount") == 1
            and not observation.get("accountWarningPresent")
            and not observation.get("generationInProgress")
        )
        if not tools_ready:
            limitations.append("PLAYWRIGHT_MCP_TOOL_SURFACE_UNAVAILABLE")
        if not binding_valid:
            limitations.append("WEB_UI_BINDING_ATTESTATION_EXPIRED")
        if tools_ready and binding_valid and not exact:
            limitations.append("WEB_UI_EXACT_TARGET_NOT_VERIFIED")
        if exact and not actionable:
            limitations.append("WEB_UI_NOT_ACTIONABLE")
        if exact:
            evidence.append(
                f"conversation-url-sha256:{web['conversationUrlDigestSha256']}"
            )
        candidate = self._candidate(
            target,
            transport_id,
            "web_ui",
            availability="available" if actionable else "unavailable",
            health="healthy" if actionable else "degraded" if tools_ready else "unavailable",
            direct_input="available" if actionable else "unavailable",
            binding="exact" if exact else "mismatch" if observation else "unknown",
            reconciliation="available" if tools_ready else "unavailable",
            surface_trust="ui_contract",
            lifecycle="responsive_idle" if actionable else "not_actionable",
            conversation_url_digest_sha256=(
                web["conversationUrlDigestSha256"] if exact else None
            ),
            evidence=evidence,
        )
        return candidate, limitations, evidence

    def _binding_time_valid(self, web: dict[str, Any]) -> bool:
        try:
            expires = dt.datetime.fromisoformat(web["bindingExpiresAt"].replace("Z", "+00:00"))
            attested = dt.datetime.fromisoformat(web["bindingAttestedAt"].replace("Z", "+00:00"))
        except ValueError:
            return False
        now = dt.datetime.now(dt.timezone.utc)
        return attested <= now < expires

    def _observe_web_ui(self, rpc: Any, web: dict[str, Any]) -> dict[str, Any]:
        selectors = self._selector_contract(web)
        function = """() => {
          const contract = %s;
          const normalize = (value) => {
            const url = new URL(value);
            const path = url.pathname.replace(/\\/+$/, '') || '/';
            return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
          };
          const unique = (selectors) => [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
          const composers = unique(contract.composerSelectors);
          const submits = unique(contract.submitSelectors).filter((node) => !node.disabled);
          const stops = unique(contract.stopSelectors).filter((node) => !node.disabled);
          const warnings = unique(contract.warningSelectors).filter((node) => node.offsetParent !== null);
          const composerText = composers.length === 1
            ? (composers[0].value ?? composers[0].innerText ?? composers[0].textContent ?? '').trim()
            : null;
          return {
            normalizedUrl: normalize(location.href),
            visible: document.visibilityState === 'visible',
            composerCount: composers.length,
            composerEmpty: composerText === '',
            submitCount: submits.length,
            generationInProgress: stops.length > 0,
            accountWarningPresent: warnings.length > 0,
            assistantCount: unique(contract.assistantMessageSelectors).length,
          };
        }""" % canonical_json(selectors)
        result = self._mcp_call(
            rpc,
            web,
            "browser_evaluate",
            {"function": function},
        )
        observed = extract_tool_json(result)
        normalized = require_string(observed.get("normalizedUrl"), "normalizedUrl", maximum=4096)
        observed["bindingExact"] = (
            sha256(normalized) == web["conversationUrlDigestSha256"]
            and urlsplit(normalized).scheme + "://" + urlsplit(normalized).netloc == web["expectedOrigin"]
        )
        return observed

    def _selector_contract(self, web: dict[str, Any]) -> dict[str, list[str]]:
        contract = web.get("selectorContract", {})
        defaults = {
            "composerSelectors": [
                "#prompt-textarea",
                "textarea[data-id='root']",
                "div[contenteditable='true'][data-lexical-editor='true']",
            ],
            "submitSelectors": [
                "button[data-testid='send-button']",
                "button[aria-label='Send prompt']",
                "button[aria-label='Send message']",
            ],
            "stopSelectors": [
                "button[data-testid='stop-button']",
                "button[aria-label='Stop generating']",
            ],
            "warningSelectors": [
                "[data-testid='account-warning']",
                "[role='alert'][data-automation-warning='true']",
            ],
            "userMessageSelectors": [
                "[data-message-author-role='user']",
                "article[data-testid^='conversation-turn'][data-message-author-role='user']",
            ],
            "assistantMessageSelectors": [
                "[data-message-author-role='assistant']",
                "article[data-testid^='conversation-turn'][data-message-author-role='assistant']",
            ],
        }
        result: dict[str, list[str]] = {}
        for key, fallback in defaults.items():
            values = contract.get(key, fallback)
            if not isinstance(values, list) or not values or any(not isinstance(value, str) or not value.strip() for value in values):
                raise BridgeError("WEB_UI_SELECTOR_CONTRACT_INVALID", f"Selector contract {key} is invalid")
            result[key] = [value.strip() for value in values]
        return result

    def _mcp_call(self, rpc: Any, web: dict[str, Any], tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return rpc.request(
            "mcpServer/tool/call",
            {
                "threadId": web["mcpThreadId"],
                "server": web.get("server", "playwright"),
                "tool": tool,
                "arguments": arguments,
            },
        )

    def _candidate(
        self,
        target: dict[str, Any],
        transport_id: str,
        kind: str,
        *,
        availability: str,
        health: str,
        direct_input: str,
        binding: str,
        reconciliation: str,
        surface_trust: str,
        lifecycle: str,
        conversation_url_digest_sha256: str | None = None,
        evidence: list[str],
    ) -> dict[str, Any]:
        return {
            "transportId": transport_id,
            "targetKind": target["targetKind"],
            "kind": kind,
            "availability": availability,
            "transportHealth": health,
            "directInput": direct_input,
            "binding": binding,
            "reconciliation": reconciliation,
            "surfaceTrust": surface_trust,
            "sessionLifecycle": lifecycle,
            **(
                {"conversationUrlDigestSha256": conversation_url_digest_sha256}
                if conversation_url_digest_sha256 is not None
                else {}
            ),
            "evidenceRefs": sorted(set(evidence)),
        }

    def _unavailable_candidates(self, target: dict[str, Any], code: str) -> list[dict[str, Any]]:
        rows = [self._candidate(
            target,
            f"codex-app-server:{target['targetAlias']}",
            "native_rpc",
            availability="unavailable",
            health="unavailable",
            direct_input="unknown",
            binding="unknown",
            reconciliation="unknown",
            surface_trust="official",
            lifecycle="not_observed",
            evidence=[f"limitation:{code}"],
        )]
        if target.get("webUi") is not None:
            rows.append(self._candidate(
                target,
                f"app-server-mcp-playwright:{target['targetAlias']}",
                "web_ui",
                availability="unavailable",
                health="unavailable",
                direct_input="unknown",
                binding="unknown",
                reconciliation="unknown",
                surface_trust="ui_contract",
                lifecycle="not_observed",
                evidence=[f"limitation:{code}"],
            ))
        return rows

    def deliver(self, request: dict[str, Any]) -> dict[str, Any]:
        target, normalized = self._validate_delivery_request(request)
        if not self.config.get("effectsEnabled", False):
            return self._no_effect_receipt(target, normalized, "BRIDGE_EFFECTS_DISABLED")
        lock_file = self._lock_path.open("a+")
        try:
            os.chmod(self._lock_path, 0o600)
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            ledger = open_ledger(self.config["stateDir"])
            try:
                existing = self._delivery_row(ledger, normalized["messageId"])
                self._assert_existing_binding(existing, normalized)
                if existing and existing["state"] == "delivered":
                    return self._receipt_from_row(existing)
                if existing and existing["state"] in {"accepted", "indeterminate", "sending"}:
                    reconciled = self._reconcile_locked(ledger, target, normalized, existing)
                    if reconciled["state"] in {"delivered", "indeterminate"}:
                        return reconciled
                status = self.status(target["targetAlias"])
                selected = next(
                    (candidate for candidate in status["candidates"] if candidate["transportId"] == normalized["transportId"]),
                    None,
                )
                if selected is None or selected["kind"] != normalized["transportKind"]:
                    return self._no_effect_receipt(target, normalized, "TRANSPORT_NOT_CURRENTLY_ATTESTED")
                if not wake_eligible_session_lifecycle(selected.get("sessionLifecycle")):
                    return self._no_effect_receipt(target, normalized, "HOST_TURN_NOT_WAKE_ELIGIBLE")
                expected_route = route_digest(
                    target_alias=target["targetAlias"],
                    target_kind=target["targetKind"],
                    target_ref_digest=normalized["targetRefDigestSha256"],
                    binding_ref=normalized["bindingRef"],
                    binding_generation=normalized["bindingGeneration"],
                    transport=selected,
                    evidence_digest=status["evidenceDigestSha256"],
                )
                if expected_route != normalized["routeDigestSha256"]:
                    return self._no_effect_receipt(target, normalized, "TRANSPORT_ROUTE_DIGEST_MISMATCH")
                now = utc_now()
                delivery_ref = f"ctd_{sha256(normalized['messageId'])[:32]}"
                ledger.execute(
                    """
                    insert into deliveries (
                      delivery_ref, permit_ref, target_alias, target_ref_digest_sha256,
                      binding_ref, binding_generation, transport_id, transport_kind,
                      route_digest_sha256, message_id, prompt_digest_sha256,
                      conversation_url_digest_sha256, state, attempts,
                      created_at, updated_at
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', 1, ?, ?)
                    on conflict(message_id) do update set
                      state='sending', attempts=attempts+1, updated_at=excluded.updated_at,
                      failure_code=null
                    """,
                    (
                        delivery_ref,
                        normalized["permitRef"],
                        target["targetAlias"],
                        normalized["targetRefDigestSha256"],
                        normalized["bindingRef"],
                        normalized["bindingGeneration"],
                        normalized["transportId"],
                        normalized["transportKind"],
                        normalized["routeDigestSha256"],
                        normalized["messageId"],
                        normalized["promptDigestSha256"],
                        normalized.get("conversationUrlDigestSha256"),
                        now,
                        now,
                    ),
                )
                ledger.commit()
                if normalized["transportKind"] == "native_rpc":
                    receipt = self._deliver_native(ledger, target, normalized)
                else:
                    receipt = self._deliver_web_ui(ledger, target, normalized)
                return receipt
            finally:
                ledger.close()
        finally:
            lock_file.close()

    def reconcile(self, request: dict[str, Any]) -> dict[str, Any]:
        target, normalized = self._validate_reconcile_request(request)
        lock_file = self._lock_path.open("a+")
        try:
            os.chmod(self._lock_path, 0o600)
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            ledger = open_ledger(self.config["stateDir"])
            try:
                existing = self._delivery_row(ledger, normalized["messageId"])
                self._assert_existing_binding(existing, normalized)
                if existing is None:
                    return self._no_effect_receipt(target, normalized, "DELIVERY_NOT_RECORDED")
                return self._reconcile_locked(ledger, target, normalized, existing)
            finally:
                ledger.close()
        finally:
            lock_file.close()

    def _validate_common(self, request: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        alias = require_string(request.get("targetAlias"), "targetAlias", maximum=200, pattern=ALIAS_PATTERN)
        target = self.target(alias)
        normalized = {
            "targetAlias": alias,
            "targetRefDigestSha256": require_sha256(request.get("targetRefDigestSha256"), "targetRefDigestSha256"),
            "bindingRef": require_string(request.get("bindingRef"), "bindingRef", maximum=1000, pattern=REF_PATTERN),
            "bindingGeneration": request.get("bindingGeneration"),
            "permitRef": require_string(request.get("permitRef"), "permitRef", maximum=1000, pattern=REF_PATTERN),
            "transportId": require_string(request.get("transportId"), "transportId", maximum=1000),
            "routeDigestSha256": require_sha256(request.get("routeDigestSha256"), "routeDigestSha256"),
            "messageId": require_string(request.get("messageId"), "messageId", maximum=200, pattern=REF_PATTERN),
            "promptDigestSha256": require_sha256(request.get("promptDigestSha256"), "promptDigestSha256"),
        }
        if not isinstance(normalized["bindingGeneration"], int) or normalized["bindingGeneration"] < 1:
            raise BridgeError("INVALID_REQUEST", "bindingGeneration must be a positive integer")
        if normalized["targetRefDigestSha256"] != sha256(canonical_json(target)):
            raise BridgeError("TARGET_BINDING_STALE", "Target configuration changed", "forbidden")
        return target, normalized

    def _validate_delivery_request(self, request: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        target, normalized = self._validate_common(request)
        transport_kind = request.get("transportKind")
        if transport_kind not in {"native_rpc", "web_ui"}:
            raise BridgeError("INVALID_REQUEST", "transportKind is unsupported")
        prompt = require_string(request.get("prompt"), "prompt", maximum=MAX_PROMPT_CHARACTERS)
        if sha256(prompt) != normalized["promptDigestSha256"]:
            raise BridgeError("PROMPT_DIGEST_MISMATCH", "Prompt digest does not match")
        conversation_url_digest = request.get("conversationUrlDigestSha256")
        if transport_kind == "web_ui":
            normalized_url_digest = require_sha256(
                conversation_url_digest,
                "conversationUrlDigestSha256",
            )
            web = target.get("webUi")
            if not isinstance(web, dict) or normalized_url_digest != web.get(
                "conversationUrlDigestSha256"
            ):
                raise BridgeError(
                    "CONVERSATION_URL_BINDING_STALE",
                    "Web UI conversation URL binding changed",
                    "forbidden",
                )
            normalized["conversationUrlDigestSha256"] = normalized_url_digest
        elif conversation_url_digest is not None:
            raise BridgeError(
                "CONVERSATION_URL_BINDING_UNEXPECTED",
                "Native delivery must not carry a browser conversation URL digest",
                "forbidden",
            )
        normalized["transportKind"] = transport_kind
        normalized["prompt"] = prompt
        return target, normalized

    def _validate_reconcile_request(self, request: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        target, normalized = self._validate_common(request)
        transport_kind = request.get("transportKind")
        if transport_kind not in {"native_rpc", "web_ui"}:
            raise BridgeError("INVALID_REQUEST", "transportKind is unsupported")
        conversation_url_digest = request.get("conversationUrlDigestSha256")
        if transport_kind == "web_ui":
            normalized_url_digest = require_sha256(
                conversation_url_digest,
                "conversationUrlDigestSha256",
            )
            web = target.get("webUi")
            if not isinstance(web, dict) or normalized_url_digest != web.get(
                "conversationUrlDigestSha256"
            ):
                raise BridgeError(
                    "CONVERSATION_URL_BINDING_STALE",
                    "Web UI conversation URL binding changed",
                    "forbidden",
                )
            normalized["conversationUrlDigestSha256"] = normalized_url_digest
        elif conversation_url_digest is not None:
            raise BridgeError(
                "CONVERSATION_URL_BINDING_UNEXPECTED",
                "Native reconciliation must not carry a browser conversation URL digest",
                "forbidden",
            )
        normalized["transportKind"] = transport_kind
        return target, normalized

    def _deliver_native(self, ledger: sqlite3.Connection, target: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
        native = target.get("native")
        if not isinstance(native, dict):
            return self._record_no_effect(ledger, request, "NATIVE_TARGET_NOT_CONFIGURED")
        try:
            with self.rpc() as rpc:
                rpc.initialize()
                found = self.relay.find_user_message(rpc, native["threadId"], request["messageId"])
                if found is None:
                    route, turn_id = self.relay.deliver(
                        rpc,
                        native["threadId"],
                        request["prompt"],
                        request["messageId"],
                    )
                    found = self.relay.find_user_message(rpc, native["threadId"], request["messageId"])
                else:
                    route, turn_id = "reconciled", found["turnId"]
        except BaseException as exc:
            return self._record_indeterminate(
                ledger,
                request,
                "NATIVE_DELIVERY_OUTCOME_UNKNOWN",
                f"native-error-sha256:{sha256(type(exc).__name__)}",
            )
        state = "delivered" if found is not None else "accepted"
        item_ref = found.get("itemId") if found else None
        return self._record_delivery(
            ledger,
            request,
            state=state,
            turn_ref=turn_id,
            item_ref=item_ref,
            generation_boundary_ref_after=turn_id if found else None,
            verification_refs=[
                f"native-route:{route}",
                f"client-message-id:{request['messageId']}",
                "reconciliation:thread-turns-list",
            ],
        )

    def _deliver_web_ui(self, ledger: sqlite3.Connection, target: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
        web = target.get("webUi")
        if not isinstance(web, dict) or not web.get("effectsEnabled", False):
            return self._record_no_effect(ledger, request, "WEB_UI_EFFECTS_DISABLED")
        marker = f"[ZES-WAKE:{request['messageId']}]"
        prompt = f"{request['prompt']}\n\n{marker}"
        try:
            with self.rpc() as rpc:
                rpc.initialize()
                before = self._observe_web_ui(rpc, web)
                if not (
                    before.get("bindingExact")
                    and before.get("visible")
                    and before.get("composerCount") == 1
                    and before.get("composerEmpty")
                    and before.get("submitCount") == 1
                    and not before.get("accountWarningPresent")
                    and not before.get("generationInProgress")
                ):
                    return self._record_no_effect(ledger, request, "WEB_UI_NOT_ACTIONABLE")
                selectors = self._selector_contract(web)
                expected_url = before["normalizedUrl"]
                function = """() => {
                  const contract = %s;
                  const expectedUrl = %s;
                  const text = %s;
                  const normalize = (value) => {
                    const url = new URL(value);
                    const path = url.pathname.replace(/\\/+$/, '') || '/';
                    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
                  };
                  const unique = (selectors) => [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
                  if (normalize(location.href) !== expectedUrl) return {submitted:false, code:'TARGET_CHANGED'};
                  const composers = unique(contract.composerSelectors);
                  const submits = unique(contract.submitSelectors).filter((node) => !node.disabled);
                  const stops = unique(contract.stopSelectors).filter((node) => !node.disabled);
                  const warnings = unique(contract.warningSelectors).filter((node) => node.offsetParent !== null);
                  if (composers.length !== 1 || submits.length !== 1 || stops.length || warnings.length) {
                    return {submitted:false, code:'NOT_ACTIONABLE'};
                  }
                  const composer = composers[0];
                  const current = (composer.value ?? composer.innerText ?? composer.textContent ?? '').trim();
                  if (current !== '') return {submitted:false, code:'COMPOSER_NOT_EMPTY'};
                  composer.focus();
                  if ('value' in composer) {
                    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), 'value');
                    descriptor?.set?.call(composer, text);
                  } else {
                    composer.textContent = text;
                  }
                  composer.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text}));
                  composer.dispatchEvent(new Event('change', {bubbles:true}));
                  const staged = (composer.value ?? composer.innerText ?? composer.textContent ?? '').trim();
                  if (staged !== text.trim()) return {submitted:false, code:'STAGING_MISMATCH'};
                  submits[0].click();
                  return {submitted:true, assistantCountBefore: unique(contract.assistantMessageSelectors).length};
                }""" % (canonical_json(selectors), canonical_json(expected_url), canonical_json(prompt))
                staged = extract_tool_json(self._mcp_call(
                    rpc,
                    web,
                    "browser_evaluate",
                    {"function": function},
                ))
                if not staged.get("submitted"):
                    return self._record_no_effect(
                        ledger,
                        request,
                        f"WEB_UI_{str(staged.get('code', 'SUBMIT_REJECTED'))}",
                    )
                try:
                    self._mcp_call(rpc, web, "browser_wait_for", {"text": marker, "time": 15})
                except BaseException:
                    pass
                after = self._observe_web_ui_marker(rpc, web, marker)
        except BaseException as exc:
            return self._record_indeterminate(
                ledger,
                request,
                "WEB_UI_DELIVERY_OUTCOME_UNKNOWN",
                f"web-ui-error-sha256:{sha256(type(exc).__name__)}",
            )
        if after.get("markerCount") != 1:
            return self._record_delivery(
                ledger,
                request,
                state="accepted",
                verification_refs=["web-ui:submit-returned", "reconciliation:marker-not-observed"],
            )
        boundary = sha256(canonical_json(after))
        return self._record_delivery(
            ledger,
            request,
            state="delivered",
            turn_ref=f"web-generation:{boundary[:32]}",
            item_ref=f"web-user-message:{sha256(marker)[:32]}",
            generation_boundary_ref_after=f"web-generation:{boundary[:32]}",
            verification_refs=[
                "web-ui:exact-marker-observed",
                "web-ui:single-user-message-admission",
                f"web-ui-boundary-sha256:{boundary}",
            ],
        )

    def _observe_web_ui_marker(self, rpc: Any, web: dict[str, Any], marker: str) -> dict[str, Any]:
        selectors = self._selector_contract(web)
        function = """() => {
          const contract = %s;
          const marker = %s;
          const unique = (selectors) => [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
          const users = unique(contract.userMessageSelectors);
          const assistants = unique(contract.assistantMessageSelectors);
          const markerNodes = users.filter((node) => (node.innerText ?? node.textContent ?? '').includes(marker));
          const stops = unique(contract.stopSelectors).filter((node) => !node.disabled);
          return {markerCount: markerNodes.length, assistantCount: assistants.length, generationInProgress: stops.length > 0};
        }""" % (canonical_json(selectors), canonical_json(marker))
        return extract_tool_json(self._mcp_call(
            rpc,
            web,
            "browser_evaluate",
            {"function": function},
        ))

    def _reconcile_locked(
        self,
        ledger: sqlite3.Connection,
        target: dict[str, Any],
        request: dict[str, Any],
        existing: dict[str, Any],
    ) -> dict[str, Any]:
        if existing["state"] == "delivered":
            return self._receipt_from_row(existing)
        if existing["transport_kind"] == "native_rpc":
            native = target.get("native")
            if not isinstance(native, dict):
                return self._record_indeterminate(ledger, request, "NATIVE_TARGET_NOT_CONFIGURED", "reconciliation:blocked")
            try:
                with self.rpc() as rpc:
                    rpc.initialize()
                    found = self.relay.find_user_message(rpc, native["threadId"], request["messageId"])
            except BaseException as exc:
                return self._record_indeterminate(
                    ledger,
                    request,
                    "NATIVE_RECONCILIATION_UNAVAILABLE",
                    f"reconcile-error-sha256:{sha256(type(exc).__name__)}",
                )
            if found is None:
                return self._record_indeterminate(ledger, request, "NATIVE_EFFECT_NOT_YET_PROVEN", "reconciliation:no-client-message-id")
            return self._record_delivery(
                ledger,
                request,
                state="delivered",
                turn_ref=found["turnId"],
                item_ref=found["itemId"],
                generation_boundary_ref_after=found["turnId"],
                verification_refs=["reconciliation:client-message-id", "native:thread-turns-list"],
            )
        web = target.get("webUi")
        if not isinstance(web, dict):
            return self._record_indeterminate(ledger, request, "WEB_UI_BINDING_NOT_CONFIGURED", "reconciliation:blocked")
        marker = f"[ZES-WAKE:{request['messageId']}]"
        try:
            with self.rpc() as rpc:
                rpc.initialize()
                after = self._observe_web_ui_marker(rpc, web, marker)
        except BaseException as exc:
            return self._record_indeterminate(
                ledger,
                request,
                "WEB_UI_RECONCILIATION_UNAVAILABLE",
                f"reconcile-error-sha256:{sha256(type(exc).__name__)}",
            )
        if after.get("markerCount") != 1:
            return self._record_indeterminate(ledger, request, "WEB_UI_EFFECT_NOT_PROVEN", "reconciliation:marker-not-observed")
        boundary = sha256(canonical_json(after))
        return self._record_delivery(
            ledger,
            request,
            state="delivered",
            turn_ref=f"web-generation:{boundary[:32]}",
            item_ref=f"web-user-message:{sha256(marker)[:32]}",
            generation_boundary_ref_after=f"web-generation:{boundary[:32]}",
            verification_refs=["reconciliation:exact-marker", f"web-ui-boundary-sha256:{boundary}"],
        )

    def _delivery_row(self, ledger: sqlite3.Connection, message_id: str) -> dict[str, Any] | None:
        cursor = ledger.execute("select * from deliveries where message_id = ?", (message_id,))
        row = cursor.fetchone()
        if row is None:
            return None
        names = [description[0] for description in cursor.description]
        return dict(zip(names, row))

    def _assert_existing_binding(self, existing: dict[str, Any] | None, request: dict[str, Any]) -> None:
        if existing is None:
            return
        checks = {
            "permit_ref": request["permitRef"],
            "target_alias": request["targetAlias"],
            "target_ref_digest_sha256": request["targetRefDigestSha256"],
            "binding_ref": request["bindingRef"],
            "binding_generation": request["bindingGeneration"],
            "transport_id": request["transportId"],
            "transport_kind": request["transportKind"],
            "route_digest_sha256": request["routeDigestSha256"],
            "prompt_digest_sha256": request["promptDigestSha256"],
            "conversation_url_digest_sha256": request.get(
                "conversationUrlDigestSha256"
            ),
        }
        if any(existing.get(key) != value for key, value in checks.items()):
            raise BridgeError(
                "IDEMPOTENCY_BINDING_CONFLICT",
                "Message id is already bound to a different permit, route, target, or prompt",
                "forbidden",
            )

    def _record_delivery(
        self,
        ledger: sqlite3.Connection,
        request: dict[str, Any],
        *,
        state: str,
        verification_refs: list[str],
        turn_ref: str | None = None,
        item_ref: str | None = None,
        generation_boundary_ref_after: str | None = None,
        failure_code: str | None = None,
    ) -> dict[str, Any]:
        now = utc_now()
        ledger.execute(
            """
            update deliveries set state=?, turn_ref=?, item_ref=?,
              generation_boundary_ref_after=?, failure_code=?, updated_at=?
             where message_id=?
            """,
            (
                state,
                turn_ref,
                item_ref,
                generation_boundary_ref_after,
                failure_code,
                now,
                request["messageId"],
            ),
        )
        ledger.commit()
        row = self._delivery_row(ledger, request["messageId"])
        assert row is not None
        return self._receipt_from_row(row, verification_refs)

    def _record_no_effect(self, ledger: sqlite3.Connection, request: dict[str, Any], code: str) -> dict[str, Any]:
        return self._record_delivery(
            ledger,
            request,
            state="no_effect",
            failure_code=code,
            verification_refs=[f"no-effect:{code}"],
        )

    def _record_indeterminate(
        self,
        ledger: sqlite3.Connection,
        request: dict[str, Any],
        code: str,
        evidence: str,
    ) -> dict[str, Any]:
        return self._record_delivery(
            ledger,
            request,
            state="indeterminate",
            failure_code=code,
            verification_refs=[evidence, f"indeterminate:{code}"],
        )

    def _no_effect_receipt(self, target: dict[str, Any], request: dict[str, Any], code: str) -> dict[str, Any]:
        now = utc_now()
        return {
            "schemaVersion": 1,
            "targetAlias": target["targetAlias"],
            "targetKind": target["targetKind"],
            "permitRef": request.get("permitRef", "unissued"),
            "transportId": request.get("transportId", "unselected"),
            "transportKind": request.get("transportKind", "native_rpc"),
            "routeDigestSha256": request.get("routeDigestSha256", "0" * 64),
            "messageId": request.get("messageId", "unissued"),
            "promptDigestSha256": request.get("promptDigestSha256", "0" * 64),
            **(
                {
                    "conversationUrlDigestSha256": request[
                        "conversationUrlDigestSha256"
                    ]
                }
                if request.get("conversationUrlDigestSha256") is not None
                else {}
            ),
            "state": "no_effect",
            "deliveryRef": f"ctd_{sha256(str(request.get('messageId', code)))[:32]}",
            "noEffectProofRef": digest_ref("no-effect", code, str(request.get("permitRef", ""))),
            "verificationRefs": [f"no-effect:{code}"],
            "failureCode": code,
            "recordedAt": now,
            "authority": AUTHORITY,
        }

    def _receipt_from_row(
        self,
        row: dict[str, Any],
        verification_refs: list[str] | None = None,
    ) -> dict[str, Any]:
        refs = verification_refs or [f"ledger-state:{row['state']}"]
        target = self.target(row["target_alias"])
        conversation_url_digest = row.get("conversation_url_digest_sha256")
        if conversation_url_digest is not None:
            refs = [*refs, f"conversation-url-sha256:{conversation_url_digest}"]
        receipt = {
            "schemaVersion": 1,
            "targetAlias": row["target_alias"],
            "targetKind": target["targetKind"],
            "permitRef": row["permit_ref"],
            "transportId": row["transport_id"],
            "transportKind": row["transport_kind"],
            "routeDigestSha256": row["route_digest_sha256"],
            "messageId": row["message_id"],
            "promptDigestSha256": row["prompt_digest_sha256"],
            **(
                {"conversationUrlDigestSha256": conversation_url_digest}
                if conversation_url_digest is not None
                else {}
            ),
            "state": row["state"],
            "deliveryRef": row["delivery_ref"],
            "verificationRefs": sorted(set(refs)),
            "recordedAt": row["updated_at"],
            "authority": AUTHORITY,
        }
        if row.get("turn_ref"):
            receipt["turnRef"] = row["turn_ref"]
        if row.get("item_ref"):
            receipt["itemRef"] = row["item_ref"]
        if row.get("generation_boundary_ref_after"):
            receipt["generationBoundaryRefAfter"] = row["generation_boundary_ref_after"]
        if row.get("failure_code"):
            receipt["failureCode"] = row["failure_code"]
        if row["state"] == "no_effect":
            receipt["noEffectProofRef"] = digest_ref("no-effect", row.get("failure_code") or "unknown", row["permit_ref"])
        return receipt


def route_digest(
    *,
    target_alias: str,
    target_kind: str,
    target_ref_digest: str,
    binding_ref: str,
    binding_generation: int,
    transport: dict[str, Any],
    evidence_digest: str,
) -> str:
    payload = {
        "bindingGeneration": binding_generation,
        "bindingRef": binding_ref,
        "evidenceDigestSha256": evidence_digest,
        "targetAlias": target_alias,
        "targetKind": target_kind,
        "targetRefDigestSha256": target_ref_digest,
        "transportId": transport["transportId"],
        "transportKind": transport["kind"],
    }
    conversation_url_digest = transport.get("conversationUrlDigestSha256")
    if conversation_url_digest is not None:
        payload["conversationUrlDigestSha256"] = conversation_url_digest
    return sha256(canonical_json(payload))


def extract_tool_json(result: dict[str, Any]) -> dict[str, Any]:
    candidates: list[str] = []
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        if isinstance(structured.get("result"), str):
            candidates.append(structured["result"])
        candidates.append(canonical_json(structured))
    for item in result.get("content", []):
        if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
            candidates.append(item["text"])
    for text in candidates:
        for candidate in (text.strip(), extract_json_object(text)):
            if not candidate:
                continue
            try:
                value = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                if isinstance(value.get("result"), dict):
                    return value["result"]
                return value
    raise BridgeError("MCP_TOOL_RESULT_INVALID", "Playwright tool did not return a JSON object")


def extract_json_object(text: str) -> str | None:
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return None


class BridgeRequestHandler(socketserver.StreamRequestHandler):
    server: "BridgeUnixServer"

    def handle(self) -> None:
        if not self.server.peer_authorized(self.request):
            return
        raw = self.rfile.readline(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            self._write_error(BridgeError("REQUEST_TOO_LARGE", "Request exceeded size limit", "forbidden"))
            return
        try:
            request = json.loads(raw.decode("utf-8"))
            if not isinstance(request, dict) or request.get("schemaVersion") != 1:
                raise BridgeError("INVALID_REQUEST", "schemaVersion must be 1")
            command = request.get("command")
            if command == "status":
                payload = {
                    "schemaVersion": 1,
                    "ok": True,
                    "command": "status",
                    "status": self.server.bridge.status(request.get("targetAlias")),
                }
            elif command == "deliver":
                payload = {
                    "schemaVersion": 1,
                    "ok": True,
                    "command": "deliver",
                    "receipt": self.server.bridge.deliver(request),
                }
            elif command == "reconcile":
                payload = {
                    "schemaVersion": 1,
                    "ok": True,
                    "command": "reconcile",
                    "receipt": self.server.bridge.reconcile(request),
                }
            elif isinstance(command, str) and command.startswith("codex_"):
                payload = {
                    "schemaVersion": 1,
                    "ok": True,
                    "command": command,
                    "data": self.server.bridge.handle_codex_gateway(request),
                }
            else:
                raise BridgeError("INVALID_COMMAND", "Command is not supported", "forbidden")
            self.wfile.write((canonical_json(payload) + "\n").encode("utf-8"))
        except (BridgeError, UnicodeError, json.JSONDecodeError, OSError, sqlite3.Error) as exc:
            error = exc if isinstance(exc, BridgeError) else BridgeError(
                "BRIDGE_INTERNAL_ERROR",
                type(exc).__name__,
                "reconcile_first",
            )
            self._write_error(error)

    def _write_error(self, error: BridgeError) -> None:
        payload = {
            "schemaVersion": 1,
            "ok": False,
            "errorCode": error.code,
            "errorDigestSha256": sha256(f"{error.code}:{type(error).__name__}:{str(error)}"),
            "retryDisposition": error.retry_disposition,
        }
        try:
            self.wfile.write((canonical_json(payload) + "\n").encode("utf-8"))
        except OSError:
            pass


class BridgeUnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.bridge = Bridge(config)
        socket_path: Path = config["socketPath"]
        socket_path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        if socket_path.exists() or socket_path.is_socket():
            socket_path.unlink()
        super().__init__(str(socket_path), BridgeRequestHandler)
        os.chmod(socket_path, int(config.get("socketMode", "0660"), 8))

    def peer_authorized(self, connection: socket.socket) -> bool:
        if not hasattr(socket, "SO_PEERCRED"):
            return False
        raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", raw)
        return uid in self.config["allowedPeerUids"]

    def server_close(self) -> None:
        path = Path(self.server_address)
        try:
            try:
                self.bridge.close()
            finally:
                super().server_close()
        finally:
            if path.exists() or path.is_socket():
                path.unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bounded ZES conversation transport bridge")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("validate-config")
    sub.add_parser("serve")
    status = sub.add_parser("status")
    status.add_argument("--target-alias", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = load_config(args.config)
    if args.command == "validate-config":
        bridge = Bridge(config)
        try:
            print(canonical_json({
                "ok": True,
                "schemaVersion": 1,
                "targetAliases": sorted(config["targets"]),
                "effectsEnabled": bool(config.get("effectsEnabled", False)),
                "codexGatewayEnabled": bridge.codex_gateway.enabled,
                "codexGatewayEffectsEnabled": bridge.codex_gateway.global_effects_enabled,
                "codexGatewayCoordinationEffectsEnabled":
                    bridge.codex_gateway.coordination_effects_enabled,
                "codexGatewayPersistentChannelsEnabled":
                    bridge.codex_gateway.persistent_channels_enabled,
                "codexServerRefs": sorted(bridge.codex_gateway.servers),
            }))
        finally:
            bridge.close()
        return 0
    if args.command == "status":
        bridge = Bridge(config)
        try:
            print(canonical_json(bridge.status(args.target_alias)))
        finally:
            bridge.close()
        return 0
    server = BridgeUnixServer(config)
    stop = threading.Event()

    def handle_signal(_signum: int, _frame: Any) -> None:
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BridgeError as exc:
        print(canonical_json({
            "ok": False,
            "errorCode": exc.code,
            "errorDigestSha256": sha256(f"{exc.code}:{str(exc)}"),
            "retryDisposition": exc.retry_disposition,
        }), file=sys.stderr)
        raise SystemExit(1)

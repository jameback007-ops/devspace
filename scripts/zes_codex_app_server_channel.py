#!/usr/bin/env python3
"""Persistent bidirectional Codex App Server channel.

The existing Codex thread relay is deliberately optimized for one short RPC
exchange.  A full App Server client also has to keep reading notifications and
server-initiated requests after ``turn/start`` returns.  This module adds that
connection lifecycle without changing Codex's native execution lane.

The channel owns only transport-local state.  It never interprets project
writer, task, publication, runtime, or business-effect authority.  Native
request identifiers and unredacted request payloads remain process-local.
Callers receive bounded projected events and opaque approval references.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
import datetime as dt
import hashlib
import json
from pathlib import Path
import random
import socket
import threading
import time
from typing import Any, Callable


SUPPORTED_INTERACTIVE_SERVER_REQUESTS = frozenset(
    {
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
        "mcpServer/elicitation/request",
        "item/permissions/requestApproval",
        "applyPatchApproval",
        "execCommandApproval",
    }
)


class ChannelError(RuntimeError):
    """Base class for persistent channel failures."""


class ChannelUnavailable(ChannelError):
    """The request was not dispatched because no channel was ready."""


class ChannelOutcomeUnknown(ChannelError):
    """The channel failed after dispatch could have crossed the effect boundary."""


class ApprovalUnavailable(ChannelError):
    """An opaque approval reference cannot be answered on the current channel."""


class ApprovalResponseConflict(ApprovalUnavailable):
    """The approval was already answered with different response material."""


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


@dataclass
class _PendingCall:
    method: str
    generation: int
    event: threading.Event = field(default_factory=threading.Event)
    response: Any = None
    error: BaseException | None = None


@dataclass
class _Approval:
    approval_ref: str
    native_request_id: int | str
    native_request_key: str
    method: str
    generation: int
    raw_params: dict[str, Any]
    projection: dict[str, Any]
    created_at: str
    stale_at_monotonic: float
    status: str = "pending"
    response_digest_sha256: str | None = None
    responded_at: str | None = None
    resolved_at: str | None = None
    expired_at: str | None = None
    resolved_event: threading.Event = field(default_factory=threading.Event)


NotificationProjector = Callable[
    [str, dict[str, Any], int],
    dict[str, Any] | None,
]
ServerRequestProjector = Callable[
    [str, dict[str, Any], int],
    dict[str, Any],
]
TransportFactory = Callable[[Path, float], Any]


class CodexAppServerChannel:
    """One reconnecting, multiplexed App Server connection.

    ``relay_module.UnixWebSocketRpc`` supplies the version-local WebSocket
    codec and initialization handshake.  After initialization, this class is
    the sole reader.  Request callers only enqueue frames and wait on their own
    response events, so notifications and server requests cannot be dropped by
    an unrelated synchronous RPC call.
    """

    def __init__(
        self,
        *,
        relay_module: Any,
        socket_path: Path,
        timeout_seconds: float,
        server_alias: str,
        notification_projector: NotificationProjector,
        server_request_projector: ServerRequestProjector,
        event_capacity: int = 2_000,
        approval_stale_after_seconds: float = 900.0,
        approval_retention_seconds: float = 3_600.0,
        reconnect_min_seconds: float = 0.25,
        reconnect_max_seconds: float = 5.0,
        transport_factory: TransportFactory | None = None,
    ) -> None:
        if event_capacity < 100 or event_capacity > 100_000:
            raise ValueError("event_capacity must be between 100 and 100000")
        if (
            approval_stale_after_seconds <= 0
            or approval_stale_after_seconds > 86_400
        ):
            raise ValueError(
                "approval_stale_after_seconds must be greater than zero and at most 86400"
            )
        if approval_retention_seconds <= 0 or approval_retention_seconds > 604_800:
            raise ValueError(
                "approval_retention_seconds must be greater than zero and at most 604800"
            )
        self.relay_module = relay_module
        self.socket_path = socket_path
        self.timeout_seconds = timeout_seconds
        self.server_alias = server_alias
        self.notification_projector = notification_projector
        self.server_request_projector = server_request_projector
        self.event_capacity = event_capacity
        self.approval_stale_after_seconds = approval_stale_after_seconds
        self.approval_retention_seconds = approval_retention_seconds
        self.reconnect_min_seconds = reconnect_min_seconds
        self.reconnect_max_seconds = reconnect_max_seconds
        self.transport_factory = transport_factory or relay_module.UnixWebSocketRpc

        self._condition = threading.Condition(threading.RLock())
        self._send_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._rpc: Any = None
        self._generation = 0
        self._next_request_id = 1_000_000
        self._pending_calls: dict[int, _PendingCall] = {}
        self._approvals: dict[str, _Approval] = {}
        self._approval_by_native_key: dict[str, str] = {}
        self._events: deque[dict[str, Any]] = deque(maxlen=event_capacity)
        self._event_sequence = 0
        self._state = "stopped"
        self._started_at: str | None = None
        self._connected_at: str | None = None
        self._last_message_at: str | None = None
        self._last_disconnect_at: str | None = None
        self._last_error_digest_sha256: str | None = None
        self._server_identity: dict[str, Any] | None = None
        self._reconnect_count = 0
        self._notifications_observed = 0
        self._server_requests_observed = 0
        self._unsupported_server_requests = 0
        self._orphan_responses = 0

    def start(self) -> None:
        with self._condition:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._state = "connecting"
            self._started_at = _utc_now()
            self._thread = threading.Thread(
                target=self._run,
                name=f"codex-app-server-{self.server_alias}",
                daemon=True,
            )
            self._thread.start()

    def close(self) -> None:
        self._stop.set()
        with self._condition:
            rpc = self._rpc
            self._state = "stopping"
            self._condition.notify_all()
        self._close_transport(rpc)
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=max(1.0, self.timeout_seconds + 1.0))
        with self._condition:
            self._state = "stopped"
            self._condition.notify_all()

    def ensure_ready(self, timeout_seconds: float | None = None) -> None:
        self.start()
        timeout = self.timeout_seconds if timeout_seconds is None else timeout_seconds
        deadline = time.monotonic() + max(0.0, timeout)
        with self._condition:
            while self._rpc is None and not self._stop.is_set():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._condition.wait(timeout=remaining)
            if self._rpc is None:
                raise ChannelUnavailable(
                    f"Codex App Server channel {self.server_alias} is not ready"
                )

    def initialize(self) -> dict[str, Any]:
        """Compatibility view for code paths that also support one-shot RPC."""
        self.ensure_ready()
        with self._condition:
            return dict(self._server_identity or {})

    def request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
    ) -> Any:
        timeout = self.timeout_seconds if timeout_seconds is None else timeout_seconds
        self.ensure_ready(timeout)
        with self._condition:
            rpc = self._rpc
            generation = self._generation
            request_id = self._next_request_id
            self._next_request_id += 1
            pending = _PendingCall(method=method, generation=generation)
            self._pending_calls[request_id] = pending
        message = {"id": request_id, "method": method, "params": params}
        try:
            self._send(rpc, generation, message)
        except Exception as exc:
            with self._condition:
                self._pending_calls.pop(request_id, None)
            raise ChannelOutcomeUnknown(
                f"Codex App Server channel failed while dispatching {method}"
            ) from exc
        if not pending.event.wait(timeout=max(0.0, timeout)):
            with self._condition:
                self._pending_calls.pop(request_id, None)
            raise ChannelOutcomeUnknown(
                f"Codex App Server did not settle {method} before the response deadline"
            )
        if pending.error is not None:
            raise pending.error
        response = pending.response
        if not isinstance(response, dict):
            raise ChannelOutcomeUnknown(
                f"Codex App Server returned a non-object response for {method}"
            )
        if "error" in response:
            raise self.relay_module.RpcError(method, response["error"])
        result = response.get("result")
        if result is None:
            return {}
        if not isinstance(result, dict):
            raise ChannelOutcomeUnknown(
                f"Codex App Server returned a non-object result for {method}"
            )
        return result

    def events(
        self,
        *,
        after_sequence: int = 0,
        limit: int = 100,
        session_ref: str | None = None,
    ) -> dict[str, Any]:
        if after_sequence < 0:
            raise ValueError("after_sequence must be non-negative")
        if limit < 1 or limit > 500:
            raise ValueError("limit must be between 1 and 500")
        with self._condition:
            events = list(self._events)
            oldest = events[0]["sequence"] if events else self._event_sequence + 1
            selected = [
                dict(event)
                for event in events
                if event["sequence"] > after_sequence
                and (
                    session_ref is None
                    or event.get("sessionRef") == session_ref
                )
            ][:limit]
            return {
                "events": selected,
                "oldestAvailableSequence": oldest,
                "latestSequence": self._event_sequence,
                "nextAfterSequence": selected[-1]["sequence"]
                if selected
                else after_sequence,
                "gapDetected": after_sequence > 0 and after_sequence < oldest - 1,
                "truncated": len(selected) >= limit,
            }

    def approvals(
        self,
        *,
        session_ref: str | None = None,
        include_terminal: bool = False,
    ) -> list[dict[str, Any]]:
        with self._condition:
            self._purge_old_approvals_locked()
            values = [
                self._approval_projection_locked(approval)
                for approval in self._approvals.values()
                if (include_terminal or approval.status in {"pending", "response_sent"})
                and (
                    session_ref is None
                    or approval.projection.get("sessionRef") == session_ref
                )
            ]
        values.sort(key=lambda value: value["createdAt"], reverse=True)
        return values

    def approval(self, approval_ref: str) -> dict[str, Any] | None:
        with self._condition:
            approval = self._approvals.get(approval_ref)
            if approval is None:
                return None
            return self._approval_projection_locked(approval)

    def approval_raw(self, approval_ref: str) -> dict[str, Any] | None:
        """Return process-local material used to validate and build a response."""
        with self._condition:
            approval = self._approvals.get(approval_ref)
            if approval is None:
                return None
            return {
                "approvalRef": approval.approval_ref,
                "method": approval.method,
                "generation": approval.generation,
                "status": approval.status,
                "rawParams": approval.raw_params,
                "projection": dict(approval.projection),
            }

    def respond(
        self,
        approval_ref: str,
        *,
        result: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
        confirm_timeout_seconds: float = 2.0,
    ) -> dict[str, Any]:
        if (result is None) == (error is None):
            raise ValueError("exactly one of result or error is required")
        response_material: dict[str, Any]
        if result is not None:
            response_material = {"result": result}
        else:
            response_material = {"error": error}
        response_digest = _digest(response_material)
        with self._condition:
            approval = self._approvals.get(approval_ref)
            if approval is None:
                raise ApprovalUnavailable("unknown approval ref")
            if approval.status == "resolved":
                if approval.response_digest_sha256 != response_digest:
                    raise ApprovalResponseConflict(
                        "approval was already resolved with different response material"
                    )
                return self._approval_projection_locked(approval)
            if approval.status not in {"pending", "response_sent"}:
                raise ApprovalUnavailable(
                    f"approval is not answerable in state {approval.status}"
                )
            if approval.status == "response_sent":
                if approval.response_digest_sha256 != response_digest:
                    raise ApprovalResponseConflict(
                        "approval response is already in flight with different material"
                    )
                wait_event = approval.resolved_event
            else:
                if self._rpc is None or self._generation != approval.generation:
                    raise ApprovalUnavailable(
                        "approval belongs to a disconnected App Server channel generation"
                    )
                rpc = self._rpc
                generation = self._generation
                payload: dict[str, Any] = {"id": approval.native_request_id}
                if result is not None:
                    payload["result"] = result
                else:
                    payload["error"] = error
                self._send(rpc, generation, payload)
                approval.status = "response_sent"
                approval.response_digest_sha256 = response_digest
                approval.responded_at = _utc_now()
                wait_event = approval.resolved_event
                self._append_event_locked(
                    {
                        "kind": "server_request_response_sent",
                        "approvalRef": approval.approval_ref,
                        "sessionRef": approval.projection.get("sessionRef"),
                        "turnRef": approval.projection.get("turnRef"),
                        "requestKind": approval.projection.get("kind"),
                    }
                )
        wait_event.wait(timeout=max(0.0, confirm_timeout_seconds))
        with self._condition:
            current = self._approvals.get(approval_ref)
            if current is None:
                raise ApprovalUnavailable("approval disappeared during reconciliation")
            return self._approval_projection_locked(current)

    def snapshot(self) -> dict[str, Any]:
        with self._condition:
            now_monotonic = time.monotonic()
            pending_approvals = sum(
                1
                for approval in self._approvals.values()
                if approval.status in {"pending", "response_sent"}
            )
            stale_approvals = sum(
                1
                for approval in self._approvals.values()
                if approval.status in {"pending", "response_sent"}
                and now_monotonic >= approval.stale_at_monotonic
            )
            return {
                "state": self._state,
                "generation": self._generation,
                "connected": self._rpc is not None,
                "startedAt": self._started_at,
                "connectedAt": self._connected_at,
                "lastMessageAt": self._last_message_at,
                "lastDisconnectAt": self._last_disconnect_at,
                "lastErrorDigestSha256": self._last_error_digest_sha256,
                "reconnectCount": self._reconnect_count,
                "pendingClientRequestCount": len(self._pending_calls),
                "pendingApprovalCount": pending_approvals,
                "staleApprovalCount": stale_approvals,
                "approvalStaleAfterSeconds": self.approval_stale_after_seconds,
                "timeAloneExpiresApproval": False,
                "notificationsObserved": self._notifications_observed,
                "serverRequestsObserved": self._server_requests_observed,
                "unsupportedServerRequests": self._unsupported_server_requests,
                "orphanResponses": self._orphan_responses,
                "eventOldestSequence": self._events[0]["sequence"]
                if self._events
                else None,
                "eventLatestSequence": self._event_sequence,
                "serverIdentity": dict(self._server_identity)
                if self._server_identity is not None
                else None,
            }

    def _run(self) -> None:
        backoff = self.reconnect_min_seconds
        first_attempt = True
        while not self._stop.is_set():
            rpc = None
            generation = 0
            try:
                with self._condition:
                    self._state = "connecting" if first_attempt else "reconnecting"
                    self._condition.notify_all()
                rpc = self.transport_factory(self.socket_path, self.timeout_seconds)
                rpc.__enter__()
                initialized = rpc.initialize()
                sock = getattr(rpc, "sock", None)
                if sock is not None:
                    # The relay's timeout protects connect/upgrade/initialize.
                    # A persistent reader must not treat ordinary idle time as
                    # a transport failure; request deadlines are enforced by
                    # each pending call instead.
                    sock.settimeout(None)
                with self._condition:
                    if self._stop.is_set():
                        break
                    self._generation += 1
                    generation = self._generation
                    self._rpc = rpc
                    self._state = "healthy"
                    self._connected_at = _utc_now()
                    self._server_identity = self._safe_server_identity(initialized)
                    self._condition.notify_all()
                    self._append_event_locked(
                        {
                            "kind": "channel_connected",
                            "connectionGeneration": generation,
                        }
                    )
                first_attempt = False
                backoff = self.reconnect_min_seconds
                self._read_loop(rpc, generation)
            except Exception as exc:
                if not self._stop.is_set():
                    with self._condition:
                        self._last_error_digest_sha256 = hashlib.sha256(
                            f"{type(exc).__name__}:{exc}".encode("utf-8")
                        ).hexdigest()
            finally:
                self._disconnect(rpc, generation)
            if self._stop.is_set():
                break
            sleep_for = min(
                self.reconnect_max_seconds,
                backoff * random.uniform(0.8, 1.2),
            )
            self._stop.wait(timeout=sleep_for)
            backoff = min(self.reconnect_max_seconds, max(backoff * 2, 0.25))
            with self._condition:
                self._reconnect_count += 1
        with self._condition:
            self._state = "stopped"
            self._condition.notify_all()

    def _read_loop(self, rpc: Any, generation: int) -> None:
        while not self._stop.is_set():
            message = rpc._recv_json()
            with self._condition:
                self._last_message_at = _utc_now()
            method = message.get("method")
            request_id = message.get("id")
            if method is not None and request_id is not None:
                self._handle_server_request(rpc, generation, message)
            elif method is not None:
                self._handle_notification(generation, message)
            elif request_id is not None:
                self._handle_response(request_id, generation, message)

    def _handle_response(
        self,
        request_id: Any,
        generation: int,
        message: dict[str, Any],
    ) -> None:
        if not isinstance(request_id, int):
            with self._condition:
                self._orphan_responses += 1
            return
        with self._condition:
            pending = self._pending_calls.pop(request_id, None)
            if pending is None or pending.generation != generation:
                self._orphan_responses += 1
                return
            pending.response = message
            pending.event.set()

    def _handle_server_request(
        self,
        rpc: Any,
        generation: int,
        message: dict[str, Any],
    ) -> None:
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params")
        if not isinstance(method, str) or not isinstance(params, dict):
            self._send(
                rpc,
                generation,
                {
                    "id": request_id,
                    "error": {
                        "code": -32600,
                        "message": "invalid server request shape",
                    },
                },
            )
            return
        with self._condition:
            self._server_requests_observed += 1
        if method not in SUPPORTED_INTERACTIVE_SERVER_REQUESTS:
            self._send(
                rpc,
                generation,
                {
                    "id": request_id,
                    "error": {
                        "code": -32601,
                        "message": "DevSpace Codex gateway does not expose this client method",
                    },
                },
            )
            with self._condition:
                self._unsupported_server_requests += 1
                self._append_event_locked(
                    {
                        "kind": "unsupported_server_request_rejected",
                        "method": method,
                        "paramsDigestSha256": _digest(params),
                    }
                )
            return
        try:
            projection = self.server_request_projector(method, params, generation)
        except Exception as exc:
            self._send(
                rpc,
                generation,
                {
                    "id": request_id,
                    "error": {
                        "code": -32603,
                        "message": "DevSpace could not safely project this server request",
                    },
                },
            )
            with self._condition:
                self._append_event_locked(
                    {
                        "kind": "server_request_projection_failed",
                        "method": method,
                        "paramsDigestSha256": _digest(params),
                        "errorDigestSha256": hashlib.sha256(
                            f"{type(exc).__name__}:{exc}".encode("utf-8")
                        ).hexdigest(),
                    }
                )
            return
        native_key = _canonical_json([generation, request_id])
        approval_ref = "cdx_apr_" + hashlib.sha256(
            _canonical_json(
                [self.server_alias, generation, request_id, method, _digest(params)]
            ).encode("utf-8")
        ).hexdigest()[:32]
        approval = _Approval(
            approval_ref=approval_ref,
            native_request_id=request_id,
            native_request_key=native_key,
            method=method,
            generation=generation,
            raw_params=params,
            projection=projection,
            created_at=_utc_now(),
            stale_at_monotonic=(
                time.monotonic() + self.approval_stale_after_seconds
            ),
        )
        with self._condition:
            existing_ref = self._approval_by_native_key.get(native_key)
            if existing_ref is not None:
                return
            self._approvals[approval_ref] = approval
            self._approval_by_native_key[native_key] = approval_ref
            self._append_event_locked(
                {
                    "kind": "server_request_pending",
                    "approvalRef": approval_ref,
                    "sessionRef": projection.get("sessionRef"),
                    "turnRef": projection.get("turnRef"),
                    "requestKind": projection.get("kind"),
                }
            )
            self._condition.notify_all()

    def _handle_notification(
        self,
        generation: int,
        message: dict[str, Any],
    ) -> None:
        method = message.get("method")
        params = message.get("params")
        if not isinstance(method, str) or not isinstance(params, dict):
            return
        with self._condition:
            self._notifications_observed += 1
            if method == "serverRequest/resolved":
                native_request_id = params.get("requestId")
                native_key = _canonical_json([generation, native_request_id])
                approval_ref = self._approval_by_native_key.get(native_key)
                if approval_ref is not None:
                    approval = self._approvals.get(approval_ref)
                    if approval is not None:
                        approval.status = "resolved"
                        approval.resolved_at = _utc_now()
                        approval.resolved_event.set()
                        self._append_event_locked(
                            {
                                "kind": "server_request_resolved",
                                "approvalRef": approval_ref,
                                "sessionRef": approval.projection.get("sessionRef"),
                                "turnRef": approval.projection.get("turnRef"),
                                "requestKind": approval.projection.get("kind"),
                            }
                        )
        try:
            projected = self.notification_projector(method, params, generation)
        except Exception as exc:
            projected = {
                "kind": "native_notification_projection_failed",
                "method": method,
                "paramsDigestSha256": _digest(params),
                "errorDigestSha256": hashlib.sha256(
                    f"{type(exc).__name__}:{exc}".encode("utf-8")
                ).hexdigest(),
            }
        if projected is not None:
            with self._condition:
                self._append_event_locked(projected)

    def _send(self, rpc: Any, generation: int, message: dict[str, Any]) -> None:
        with self._send_lock:
            with self._condition:
                if rpc is None or self._rpc is not rpc or self._generation != generation:
                    raise ChannelUnavailable("Codex channel generation changed before send")
            try:
                rpc._send_json(message)
            except Exception:
                self._close_transport(rpc)
                raise

    def _disconnect(self, rpc: Any, generation: int) -> None:
        now = _utc_now()
        with self._condition:
            if self._rpc is rpc:
                self._rpc = None
            if not self._stop.is_set():
                self._state = "reconnecting"
            self._last_disconnect_at = now
            for request_id, pending in list(self._pending_calls.items()):
                if pending.generation != generation:
                    continue
                self._pending_calls.pop(request_id, None)
                pending.error = ChannelOutcomeUnknown(
                    f"Codex App Server disconnected while {pending.method} was in flight"
                )
                pending.event.set()
            for approval in self._approvals.values():
                if (
                    approval.generation == generation
                    and approval.status in {"pending", "response_sent"}
                ):
                    approval.status = "expired"
                    approval.expired_at = now
                    approval.resolved_event.set()
            if generation > 0:
                self._append_event_locked(
                    {
                        "kind": "channel_disconnected",
                        "connectionGeneration": generation,
                        "errorDigestSha256": self._last_error_digest_sha256,
                    }
                )
            self._condition.notify_all()
        self._close_transport(rpc)

    def _close_transport(self, rpc: Any) -> None:
        if rpc is None:
            return
        sock = getattr(rpc, "sock", None)
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        try:
            rpc.__exit__(None, None, None)
        except Exception:
            pass

    def _append_event_locked(self, event: dict[str, Any]) -> None:
        self._event_sequence += 1
        value = {
            "sequence": self._event_sequence,
            "observedAt": _utc_now(),
            "connectionGeneration": self._generation,
            **event,
        }
        serialized = _canonical_json(value)
        if len(serialized) > 32_000:
            value = {
                "sequence": self._event_sequence,
                "observedAt": value["observedAt"],
                "connectionGeneration": value["connectionGeneration"],
                "kind": "oversized_event_omitted",
                "eventDigestSha256": hashlib.sha256(
                    serialized.encode("utf-8")
                ).hexdigest(),
                "eventCharacters": len(serialized),
            }
        self._events.append(value)

    def _approval_projection_locked(self, approval: _Approval) -> dict[str, Any]:
        now_monotonic = time.monotonic()
        stale = (
            approval.status in {"pending", "response_sent"}
            and now_monotonic >= approval.stale_at_monotonic
        )
        connected_generation = (
            self._rpc is not None and self._generation == approval.generation
        )
        return {
            "approvalRef": approval.approval_ref,
            "method": approval.method,
            "status": approval.status,
            "connectionGeneration": approval.generation,
            "createdAt": approval.created_at,
            "respondedAt": approval.responded_at,
            "resolvedAt": approval.resolved_at,
            "expiredAt": approval.expired_at,
            "stale": stale,
            "freshness": "stale" if stale else "fresh",
            "staleAfterSeconds": self.approval_stale_after_seconds,
            "answerable": (
                approval.status == "pending" and connected_generation
            ),
            "responsePendingConfirmation": (
                approval.status == "response_sent" and connected_generation
            ),
            "timeAloneExpiresApproval": False,
            "responseDigestSha256": approval.response_digest_sha256,
            "responseConfirmed": approval.status == "resolved",
            **approval.projection,
        }

    def _purge_old_approvals_locked(self) -> None:
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(
            seconds=self.approval_retention_seconds
        )
        for approval_ref, approval in list(self._approvals.items()):
            terminal_at = approval.resolved_at or approval.expired_at
            if terminal_at is None:
                continue
            try:
                terminal = dt.datetime.fromisoformat(terminal_at)
            except ValueError:
                terminal = cutoff - dt.timedelta(seconds=1)
            if terminal < cutoff:
                self._approvals.pop(approval_ref, None)
                self._approval_by_native_key.pop(
                    approval.native_request_key,
                    None,
                )

    @staticmethod
    def _safe_server_identity(initialized: Any) -> dict[str, Any]:
        if not isinstance(initialized, dict):
            return {}
        return {
            "userAgent": str(initialized.get("userAgent") or "")[:500],
            "platformFamily": initialized.get("platformFamily"),
            "platformOs": initialized.get("platformOs"),
        }

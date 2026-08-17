import assert from "node:assert/strict";
import {
  codexSessionAdapterStatus,
  unavailableCodexSessionAdapterObservation,
} from "./zes-codex-inspection.js";

const recoverableSystemError = codexSessionAdapterStatus(
  {
    session: {
      statusSource: "app-server",
      status: { type: "systemError" },
      canAcceptDirectInput: true,
      recentlyPersisting: false,
    },
  },
  "status",
);

assert.deepEqual(recoverableSystemError, {
  adapterKind: "codex_app_server",
  observationKind: "status",
  overallHealth: "degraded",
  readerTransport: "healthy",
  appServerTransport: "healthy",
  threadLifecycle: "systemError",
  directInput: "available",
  persistence: "stale",
  devspaceExecutorPlaneImpact: "none",
  interpretation:
    "The Codex App Server transport is healthy. The observed thread lifecycle reports systemError, while the same thread still accepts direct input; this is a thread state, not a DevSpace or VPS outage.",
});

const unavailableAppServer = codexSessionAdapterStatus(
  {
    session: {
      statusSource: "unavailable-within-3s",
      status: null,
      canAcceptDirectInput: null,
      recentlyPersisting: true,
    },
  },
  "status",
);

assert.equal(unavailableAppServer.overallHealth, "degraded");
assert.equal(unavailableAppServer.readerTransport, "healthy");
assert.equal(unavailableAppServer.appServerTransport, "unavailable");
assert.equal(unavailableAppServer.threadLifecycle, "unknown");
assert.equal(unavailableAppServer.directInput, "unknown");
assert.equal(unavailableAppServer.persistence, "fresh");
assert.equal(unavailableAppServer.devspaceExecutorPlaneImpact, "none");

const persistedTail = codexSessionAdapterStatus({}, "tail");
assert.equal(persistedTail.overallHealth, "healthy");
assert.equal(persistedTail.readerTransport, "healthy");
assert.equal(persistedTail.appServerTransport, "not_observed");
assert.equal(persistedTail.threadLifecycle, "not_observed");
assert.equal(persistedTail.directInput, "not_observed");
assert.equal(persistedTail.devspaceExecutorPlaneImpact, "none");

const unavailableReader = unavailableCodexSessionAdapterObservation(
  "audit",
  "socket unavailable",
);
assert.deepEqual(unavailableReader.adapterStatus, {
  adapterKind: "codex_app_server",
  observationKind: "audit",
  overallHealth: "unavailable",
  readerTransport: "unavailable",
  appServerTransport: "not_observed",
  threadLifecycle: "not_observed",
  directInput: "not_observed",
  persistence: "unknown",
  devspaceExecutorPlaneImpact: "none",
  interpretation:
    "The optional Codex session adapter could not be observed. DevSpace workspace and VPS execution remain independent.",
});
assert.deepEqual(unavailableReader.adapterError, {
  kind: "codex_session_adapter_unavailable",
  summary: "socket unavailable",
});

console.log("zes codex inspection tests passed");

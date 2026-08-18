import assert from "node:assert/strict";
import test from "node:test";
import {
  InteractionController,
  InteractionPolicyError,
  InteractionSession,
  selectInteractionRoute,
  type InteractionActionRequest,
  type InteractionAdapter,
  type InteractionAdapterDescriptor,
  type InteractionApprovalVerifier,
  type InteractionReconciliationVerifier,
  type InteractionBinding,
  type InteractionObservation,
  type InteractionObservationInput,
} from "./interaction-harness.js";

const sha = (character: string): string => character.repeat(64);

function ids() {
  let sequence = 0;
  return (prefix: "ixs" | "obs" | "act"): string => {
    sequence += 1;
    return `${prefix}_${String(sequence).padStart(4, "0")}`;
  };
}

const playwrightDescriptor: InteractionAdapterDescriptor = {
  id: "playwright-existing-browser",
  surface: "playwright",
  available: true,
  targetKinds: ["browser"],
  supportedActionKinds: [
    "inspect",
    "navigate",
    "click",
    "type",
    "select",
    "upload",
    "download",
    "window_control",
  ],
  minimumEffectClassByAction: {
    inspect: "read_only",
    navigate: "reversible",
    click: "reversible",
    type: "reversible",
    select: "reversible",
    upload: "irreversible",
    download: "reversible",
    window_control: "reversible",
  },
  capabilities: {
    observe: true,
    semanticTargeting: true,
    coordinateTargeting: false,
    verify: true,
    boundedTimeout: true,
    screenshotEvidence: true,
    traceEvidence: true,
    persistentSession: true,
    isolatedSession: false,
    visibleUi: true,
    fileTransfer: true,
  },
  concurrency: "exclusive",
  busy: false,
  sessionRef: "browser-extension-session",
};

const visionDescriptor: InteractionAdapterDescriptor = {
  id: "desktop-vision",
  surface: "vision_pointer",
  available: true,
  targetKinds: ["browser", "native_desktop", "remote_desktop"],
  supportedActionKinds: ["inspect", "click", "type", "window_control"],
  minimumEffectClassByAction: {
    inspect: "read_only",
    click: "reversible",
    type: "reversible",
    window_control: "reversible",
  },
  capabilities: {
    observe: true,
    semanticTargeting: false,
    coordinateTargeting: true,
    verify: true,
    boundedTimeout: true,
    screenshotEvidence: true,
    traceEvidence: false,
    persistentSession: true,
    isolatedSession: false,
    visibleUi: true,
    fileTransfer: false,
  },
  concurrency: "exclusive",
  busy: false,
};

const approvalVerifier: InteractionApprovalVerifier = ({ approval }) => ({
  verified: approval.state === "approved",
  verificationRef: "approval-verification://interaction-harness-test/1",
  authorityReadbackRef: "owner-readback://interaction-harness-test/1",
});

const reconciliationVerifier: InteractionReconciliationVerifier = ({
  resolution,
}) => ({
  verified: resolution === "effect_absent" || resolution === "effect_verified",
  verificationRef: "reconciliation-verification://interaction-harness-test/1",
  authorityReadbackRef: "owner-readback://interaction-harness-test/reconciliation/1",
});

const binding: InteractionBinding = {
  adapterId: playwrightDescriptor.id,
  surface: "playwright",
  backendSessionRef: "browser-extension-session",
  contextRef: "tab-7",
  targetKind: "browser",
};

function observationInput(
  overrides: Partial<InteractionObservationInput> = {},
): InteractionObservationInput {
  return {
    binding,
    stateDigestSha256: sha("a"),
    observedAt: "2026-08-18T05:00:00.000Z",
    evidence: [
      {
        kind: "accessibility_snapshot",
        ref: "artifact://interaction/tab-7/snapshot-1",
        sha256: sha("b"),
      },
    ],
    frontier: {
      url: "https://example.test/settings",
      title: "Settings",
      focusedTargetRef: "role=button[name=Save]",
    },
    ...overrides,
  };
}

function readOnlyAction(
  observation: InteractionObservation,
  overrides: Partial<InteractionActionRequest> = {},
): InteractionActionRequest {
  return {
    idempotencyKey: "inspect-settings-once",
    kind: "inspect",
    effectClass: "read_only",
    target: {
      strategy: "semantic",
      role: "heading",
      accessibleName: "Settings",
    },
    expectedObservationId: observation.observationId,
    expectedPreStateDigestSha256: observation.stateDigestSha256,
    approval: { state: "not_required" },
    ...overrides,
  };
}

function mutatingAction(
  observation: InteractionObservation,
  overrides: Partial<InteractionActionRequest> = {},
): InteractionActionRequest {
  return {
    idempotencyKey: "save-settings-once",
    kind: "click",
    effectClass: "reversible",
    target: {
      strategy: "semantic",
      role: "button",
      accessibleName: "Save",
    },
    expectedObservationId: observation.observationId,
    expectedPreStateDigestSha256: observation.stateDigestSha256,
    payloadDigestSha256: sha("c"),
    declaredIdempotent: true,
    approval: {
      state: "approved",
      ref: "owner-approval://save-settings/1",
      actorRef: "owner",
    },
    postconditions: [
      {
        kind: "text_visible",
        expected: "Settings saved",
      },
    ],
    ...overrides,
  };
}

function session() {
  let now = Date.parse("2026-08-18T05:00:00.000Z");
  return {
    instance: new InteractionSession(
      {
        executionScopeRef: "0123456789abcdef",
        workspaceId: "ws_interaction",
        missionRef: "interaction-harness-test",
      },
      {
        idFactory: ids(),
        now: () => now,
        approvalVerifier,
        reconciliationVerifier,
      },
    ),
    advance(milliseconds = 1_000) {
      now += milliseconds;
    },
  };
}

test("routing prefers deterministic semantic surfaces and keeps vision opt-in", () => {
  const api: InteractionAdapterDescriptor = {
    ...playwrightDescriptor,
    id: "service-api",
    surface: "api",
    targetKinds: ["service"],
    concurrency: "shared",
  };
  const shell: InteractionAdapterDescriptor = {
    ...playwrightDescriptor,
    id: "service-shell",
    surface: "shell",
    targetKinds: ["service", "terminal"],
    concurrency: "shared",
  };

  const serviceRoute = selectInteractionRoute(
    { targetKind: "service", effectClass: "read_only" },
    [shell, api, visionDescriptor],
  );
  assert.equal(serviceRoute.selected?.id, "service-api");

  const browserRoute = selectInteractionRoute(
    {
      targetKind: "browser",
      effectClass: "read_only",
      visibleUiRequired: true,
    },
    [visionDescriptor, playwrightDescriptor],
  );
  assert.equal(browserRoute.selected?.id, playwrightDescriptor.id);
  assert.deepEqual(
    browserRoute.candidates.find((entry) => entry.adapterId === visionDescriptor.id)?.reasons,
    ["coordinate_fallback_not_authorized"],
  );
});

test("an exclusive busy browser adapter is held instead of creating a competing client", () => {
  const route = selectInteractionRoute(
    {
      targetKind: "browser",
      effectClass: "read_only",
      existingSessionRequired: true,
    },
    [{ ...playwrightDescriptor, busy: true }],
  );
  assert.equal(route.selected, undefined);
  assert.equal(route.heldReason, "no_eligible_interaction_adapter");
  assert.match(route.candidates[0]?.reasons.join(" ") ?? "", /exclusive_adapter_busy/);
});

test("a stale observation or pre-state digest cannot authorize an action", () => {
  const { instance } = session();
  instance.recordObservation(observationInput());
  const observation = instance.checkpoint().observation;
  assert.ok(observation);

  assert.throws(
    () => instance.beginAction(
      readOnlyAction(observation, { expectedObservationId: "obs_stale" }),
      playwrightDescriptor,
    ),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "stale_observation",
  );
  assert.throws(
    () => instance.beginAction(
      readOnlyAction(observation, {
        expectedPreStateDigestSha256: sha("f"),
      }),
      playwrightDescriptor,
    ),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "stale_pre_state_digest",
  );
  assert.equal(instance.checkpoint().state, "ready");
});

test("mutating actions require approval and an explicit postcondition", () => {
  const { instance } = session();
  instance.recordObservation(observationInput());
  const observation = instance.checkpoint().observation;
  assert.ok(observation);

  assert.throws(
    () => instance.beginAction(
      mutatingAction(observation, {
        approval: { state: "not_required" },
      }),
      playwrightDescriptor,
    ),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "mutating_action_requires_approval",
  );
  assert.throws(
    () => instance.beginAction(
      mutatingAction(observation, { postconditions: [] }),
      playwrightDescriptor,
    ),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "mutating_action_requires_postcondition",
  );
});

test("mutating approval claims fail closed without an external verifier", () => {
  const instance = new InteractionSession(
    {
      executionScopeRef: "0123456789abcdef",
      workspaceId: "ws_interaction",
    },
    { idFactory: ids() },
  );
  instance.recordObservation(observationInput());
  const observation = instance.checkpoint().observation;
  assert.ok(observation);

  assert.throws(
    () => instance.beginAction(mutatingAction(observation), playwrightDescriptor),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "mutating_action_approval_unverified",
  );
});

test("adapter action allowlists reject raw execution on the Playwright bridge", () => {
  const { instance } = session();
  instance.recordObservation(observationInput());
  const observation = instance.checkpoint().observation;
  assert.ok(observation);

  assert.throws(
    () => instance.beginAction(
      readOnlyAction(observation, { kind: "execute" }),
      playwrightDescriptor,
    ),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "interaction_action_kind_unsupported",
  );
});

test("adapter effect floors reject caller underclassification", () => {
  const { instance } = session();
  instance.recordObservation(observationInput());
  const observation = instance.checkpoint().observation;
  assert.ok(observation);

  assert.throws(
    () => instance.beginAction(
      readOnlyAction(observation, {
        kind: "click",
        target: {
          strategy: "semantic",
          role: "button",
          accessibleName: "Expand",
        },
      }),
      playwrightDescriptor,
    ),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "interaction_effect_class_underclassified",
  );
});

test("coordinate targeting is allowed only after semantic exhaustion on the exact screenshot viewport", () => {
  const { instance } = session();
  const coordinateBinding: InteractionBinding = {
    adapterId: visionDescriptor.id,
    surface: "vision_pointer",
    backendSessionRef: "desktop-session-10",
    contextRef: "display-10",
    targetKind: "native_desktop",
  };
  instance.recordObservation(observationInput({
    binding: coordinateBinding,
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    evidence: [
      {
        kind: "screenshot",
        ref: "artifact://interaction/display-10/screenshot-1.png",
        sha256: sha("d"),
      },
    ],
  }));
  const observation = instance.checkpoint().observation;
  assert.ok(observation);

  const coordinateAction: InteractionActionRequest = {
    idempotencyKey: "click-coordinate-once",
    kind: "click",
    effectClass: "reversible",
    target: {
      strategy: "coordinate",
      x: 640,
      y: 480,
      viewportWidth: 1920,
      viewportHeight: 1080,
      semanticFallbackExhausted: true,
      sourceObservationId: observation.observationId,
    },
    expectedObservationId: observation.observationId,
    expectedPreStateDigestSha256: observation.stateDigestSha256,
    approval: {
      state: "approved",
      ref: "owner-approval://coordinate-click/1",
      actorRef: "owner",
    },
    postconditions: [
      {
        kind: "custom",
        expected: "target state changes as observed",
      },
    ],
  };
  assert.equal(
    instance.beginAction(coordinateAction, visionDescriptor).started,
    true,
  );

  const missingScreenshot = session().instance;
  missingScreenshot.recordObservation(observationInput({
    binding: coordinateBinding,
    viewport: { width: 1920, height: 1080 },
  }));
  const missingObservation = missingScreenshot.checkpoint().observation;
  assert.ok(missingObservation);
  assert.equal(coordinateAction.target.strategy, "coordinate");
  const priorCoordinateTarget = coordinateAction.target.strategy === "coordinate"
    ? coordinateAction.target
    : undefined;
  assert.ok(priorCoordinateTarget);
  assert.throws(
    () => missingScreenshot.beginAction(
      {
        ...coordinateAction,
        idempotencyKey: "missing-screenshot",
        expectedObservationId: missingObservation.observationId,
        expectedPreStateDigestSha256: missingObservation.stateDigestSha256,
        target: {
          ...priorCoordinateTarget,
          sourceObservationId: missingObservation.observationId,
        },
      },
      visionDescriptor,
    ),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "coordinate_screenshot_evidence_required",
  );
});

test("an unknown or unproved failed effect becomes indeterminate and blocks replay", () => {
  const { instance } = session();
  instance.recordObservation(observationInput());
  const observation = instance.checkpoint().observation;
  assert.ok(observation);
  const start = instance.beginAction(mutatingAction(observation), playwrightDescriptor);
  assert.equal(
    start.action.approvalVerificationRef,
    "approval-verification://interaction-harness-test/1",
  );
  assert.equal(
    start.action.approvalAuthorityReadbackRef,
    "owner-readback://interaction-harness-test/1",
  );
  instance.recordActionOutcome({
    actionId: start.action.actionId,
    status: "unknown",
    detailCode: "transport_closed_after_click",
  });
  assert.equal(instance.checkpoint().state, "indeterminate");
  assert.equal(instance.recover(binding).replayAllowed, false);
  assert.throws(
    () => instance.beginAction(mutatingAction(observation), playwrightDescriptor),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "indeterminate_effect_requires_reconciliation",
  );
});

test("indeterminate effects require exact binding readback and can be resolved without replay", () => {
  const { instance, advance } = session();
  instance.recordObservation(observationInput());
  const observation = instance.checkpoint().observation;
  assert.ok(observation);
  const start = instance.beginAction(mutatingAction(observation), playwrightDescriptor);
  instance.recordActionOutcome({
    actionId: start.action.actionId,
    status: "failed",
    noEffectProven: false,
  });
  advance();

  assert.throws(
    () => instance.resolveIndeterminate({
      actionId: start.action.actionId,
      resolution: "effect_absent",
      binding: { ...binding, contextRef: "another-tab" },
      postStateDigestSha256: sha("a"),
      evidence: [{ kind: "accessibility_snapshot", ref: "artifact://wrong-tab" }],
    }),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "resolution_binding_mismatch",
  );

  const checkpoint = instance.resolveIndeterminate({
    actionId: start.action.actionId,
    resolution: "effect_verified",
    binding,
    postStateDigestSha256: sha("e"),
    evidence: [
      {
        kind: "accessibility_snapshot",
        ref: "artifact://interaction/tab-7/reconciliation",
        sha256: sha("f"),
      },
    ],
  });
  assert.equal(checkpoint.state, "verified");
  assert.equal(checkpoint.pendingAction, undefined);
  assert.equal(checkpoint.verification?.actionId, start.action.actionId);
  assert.equal(checkpoint.reconciliation?.actionId, start.action.actionId);
  assert.equal(checkpoint.reconciliation?.resolution, "effect_verified");
  assert.equal(
    checkpoint.reconciliation?.verificationRef,
    "reconciliation-verification://interaction-harness-test/1",
  );
  assert.equal(
    checkpoint.reconciliation?.authorityReadbackRef,
    "owner-readback://interaction-harness-test/reconciliation/1",
  );
});

test("indeterminate effects cannot be resolved from caller claims without an external verifier", () => {
  const instance = new InteractionSession(
    {
      executionScopeRef: "0123456789abcdef",
      workspaceId: "ws_interaction",
    },
    {
      idFactory: ids(),
      approvalVerifier,
    },
  );
  instance.recordObservation(observationInput());
  const observation = instance.checkpoint().observation;
  assert.ok(observation);
  const start = instance.beginAction(
    mutatingAction(observation),
    playwrightDescriptor,
  );
  instance.recordActionOutcome({
    actionId: start.action.actionId,
    status: "unknown",
  });

  assert.throws(
    () => instance.resolveIndeterminate({
      actionId: start.action.actionId,
      resolution: "effect_absent",
      binding,
      postStateDigestSha256: sha("a"),
      evidence: [
        {
          kind: "accessibility_snapshot",
          ref: "artifact://interaction/tab-7/unverified-reconciliation",
        },
      ],
    }),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "indeterminate_reconciliation_unverified",
  );
  assert.equal(instance.checkpoint().state, "indeterminate");
});

test("idempotency keys reject payload drift and return a verified receipt without re-executing", () => {
  const { instance } = session();
  instance.recordObservation(observationInput());
  const observation = instance.checkpoint().observation;
  assert.ok(observation);
  const request = readOnlyAction(observation);
  const start = instance.beginAction(request, playwrightDescriptor);

  assert.throws(
    () => instance.beginAction(
      { ...request, target: { strategy: "semantic", role: "button", accessibleName: "Other" } },
      playwrightDescriptor,
    ),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "idempotency_payload_mismatch",
  );

  instance.recordActionOutcome({
    actionId: start.action.actionId,
    status: "succeeded",
    evidence: [{ kind: "trace", ref: "artifact://trace/action-1", sha256: sha("1") }],
  });
  instance.recordVerification({
    actionId: start.action.actionId,
    verified: true,
    binding,
    postStateDigestSha256: sha("2"),
    evidence: [
      {
        kind: "accessibility_snapshot",
        ref: "artifact://interaction/tab-7/post-1",
        sha256: sha("3"),
      },
    ],
  });

  const replay = instance.beginAction(request, playwrightDescriptor);
  assert.equal(replay.started, false);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.action.actionId, start.action.actionId);
  assert.equal(replay.checkpoint.state, "verified");
});

test("process recovery with an unsettled action fails closed into reconciliation", () => {
  const { instance } = session();
  instance.recordObservation(observationInput());
  const observation = instance.checkpoint().observation;
  assert.ok(observation);
  instance.beginAction(readOnlyAction(observation), playwrightDescriptor);

  const recovered = instance.recover(binding);
  assert.equal(recovered.state, "indeterminate");
  assert.equal(recovered.disposition, "resolve_indeterminate");
  assert.equal(recovered.replayAllowed, false);
});

test("binding changes invalidate ordinary continuation and force a new observation", () => {
  const { instance } = session();
  instance.recordObservation(observationInput());
  const recovered = instance.recover({ ...binding, contextRef: "tab-8" });
  assert.equal(recovered.state, "needs_observation");
  assert.equal(recovered.disposition, "reobserve");
  assert.equal(recovered.replayAllowed, false);
});

test("checkpoints contain only sensitive state references and restore coherently", () => {
  const { instance } = session();
  instance.recordObservation(observationInput({
    frontier: {
      url: "https://example.test/settings?token=session-secret#private-fragment",
      title: "Settings",
    },
    sensitiveStateRefs: [
      {
        kind: "storage_state",
        ref: "secret-ref://browser/storage-state/7",
        sha256: sha("4"),
      },
    ],
  }));
  const checkpoint = instance.checkpoint();
  const serialized = JSON.stringify(checkpoint);
  assert.match(serialized, /secret-ref:\/\/browser\/storage-state\/7/);
  assert.doesNotMatch(serialized, /session-cookie-value|bearer-token-value/);
  assert.doesNotMatch(serialized, /session-secret|private-fragment/);
  assert.equal(
    checkpoint.observation?.frontier?.url,
    "https://example.test/settings",
  );
  assert.equal(checkpoint.policy.rawCredentialCaptureAllowed, false);

  const restored = InteractionSession.restore(checkpoint, {
    idFactory: ids(),
    now: () => Date.parse("2026-08-18T05:10:00.000Z"),
    approvalVerifier,
    reconciliationVerifier,
  });
  assert.deepEqual(restored.checkpoint(), checkpoint);
});

test("credential-bearing evidence references are rejected before checkpointing", () => {
  const { instance } = session();
  assert.throws(
    () => instance.recordObservation(observationInput({
      evidence: [
        {
          kind: "screenshot",
          ref: "https://example.test/evidence?token=embedded-secret",
        },
      ],
    })),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "credential_bearing_reference_rejected",
  );
});

test("controller runs observe-act-verify and never treats adapter success as completion", async () => {
  const harness = session().instance;
  const calls: string[] = [];
  const adapter: InteractionAdapter = {
    descriptor: playwrightDescriptor,
    async observe(): Promise<InteractionObservationInput> {
      calls.push("observe");
      return observationInput();
    },
    async act(action) {
      calls.push("act");
      return {
        actionId: action.actionId,
        status: "succeeded",
        evidence: [
          {
            kind: "trace",
            ref: "artifact://interaction/tab-7/action-trace",
            sha256: sha("5"),
          },
        ],
      };
    },
    async verify(action) {
      calls.push("verify");
      return {
        actionId: action.actionId,
        verified: true,
        binding,
        postStateDigestSha256: sha("6"),
        evidence: [
          {
            kind: "accessibility_snapshot",
            ref: "artifact://interaction/tab-7/post-action",
            sha256: sha("7"),
          },
        ],
        frontier: {
          url: "https://example.test/settings",
          title: "Settings saved",
        },
      };
    },
  };
  const controller = new InteractionController(harness, [adapter]);
  const result = await controller.execute(
    {
      targetKind: "browser",
      effectClass: "read_only",
      visibleUiRequired: true,
      existingSessionRequired: true,
    },
    (observation) => readOnlyAction(observation),
  );
  assert.deepEqual(calls, ["observe", "act", "verify"]);
  assert.equal(result.checkpoint.state, "verified");
  assert.equal(result.checkpoint.verification?.postStateDigestSha256, sha("6"));
  assert.equal(result.checkpoint.pendingAction, undefined);
});

test("in-memory controllers reject mutation and require the durable broker", async () => {
  const harness = session().instance;
  const controller = new InteractionController(harness, [
    {
      descriptor: playwrightDescriptor,
      async observe() {
        return observationInput();
      },
      async act(action) {
        return { actionId: action.actionId, status: "succeeded" };
      },
      async verify(action) {
        return {
          actionId: action.actionId,
          verified: true,
          binding,
          postStateDigestSha256: sha("8"),
          evidence: [
            { kind: "accessibility_snapshot", ref: "artifact://post" },
          ],
        };
      },
    },
  ]);

  await assert.rejects(
    () => controller.execute(
      { targetKind: "browser", effectClass: "reversible" },
      (observation) => mutatingAction(observation),
    ),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "durable_interaction_broker_required",
  );
});

test("controller routing intent cannot be used to disguise a different action effect", async () => {
  const harness = session().instance;
  const controller = new InteractionController(harness, [
    {
      descriptor: playwrightDescriptor,
      async observe() {
        return observationInput();
      },
      async act(action) {
        return { actionId: action.actionId, status: "succeeded" };
      },
      async verify(action) {
        return {
          actionId: action.actionId,
          verified: true,
          binding,
          postStateDigestSha256: sha("9"),
          evidence: [
            { kind: "accessibility_snapshot", ref: "artifact://post/mismatch" },
          ],
        };
      },
    },
  ]);

  await assert.rejects(
    () => controller.execute(
      { targetKind: "browser", effectClass: "read_only" },
      (observation) => mutatingAction(observation),
    ),
    (error: unknown) => error instanceof InteractionPolicyError
      && error.code === "interaction_intent_action_effect_mismatch",
  );
});

test("controller converts transport loss after dispatch into an indeterminate effect", async () => {
  const harness = session().instance;
  const adapter: InteractionAdapter = {
    descriptor: playwrightDescriptor,
    async observe() {
      return observationInput();
    },
    async act() {
      throw new Error("connection closed");
    },
    async verify() {
      throw new Error("must not be called");
    },
  };
  const controller = new InteractionController(harness, [adapter]);
  const result = await controller.execute(
    {
      targetKind: "browser",
      effectClass: "read_only",
      visibleUiRequired: true,
    },
    (observation) => readOnlyAction(observation),
  );
  assert.equal(result.outcome?.status, "unknown");
  assert.equal(result.checkpoint.state, "indeterminate");
  assert.equal(result.checkpoint.policy.unknownOutcomeReplayAllowed, false);
});

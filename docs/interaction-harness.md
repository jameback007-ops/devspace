# DevSpace Interaction Harness

Status: isolated candidate architecture, executor-local control core, and durable-broker contract. The provider-neutral state machine, fixed live-runtime probe, lease/CAS broker, cross-scope handoff model, and focused behavioral tests are implemented. Browser/desktop action tools are not yet registered or activated.

## Purpose

DevSpace already owns executor-local workspaces, process sessions, audit, recovery capsules, turn continuity, and durable local-agent continuation. The VPS already owns a visible Cinnamon/XRDP desktop, and Codex already uses a Playwright MCP extension bridge against that desktop. The missing capability is not another GUI stack or another browser engine. It is a DevSpace-native interaction control loop that binds an existing browser or desktop session to an execution scope, prevents stale or duplicate effects, records bounded evidence, and survives provider or process boundaries.

The target invariant is:

```text
current execution scope + exact interaction session/context
    -> current observation
    -> one policy-qualified action
    -> explicit verification
    -> executor-local checkpoint
    -> continue, re-observe, or reconcile
```

This layer is an executor harness. It is not a canonical task store, decision authority, writer lease owner, workflow authority, effect outcome authority, memory system, or publication authority.

## Existing live topology

The bounded live probe is intentionally fixed to the existing ZES installation:

```text
Codex / future DevSpace broker
    -> /usr/local/bin/zes-playwright-mcp
    -> @playwright/mcp --extension
    -> existing Chrome/Edge extension session
    -> DISPLAY :10
    -> Xorg + Cinnamon 2D
    -> XRDP transport
```

The wrapper reads the extension credential from a fixed root-owned reference and starts Playwright as `zes-owner`. The interaction runtime probe checks only fixed paths, fixed process patterns, the fixed display socket, and the fixed service. It never returns the credential value and accepts no model-supplied path or command.

XRDP is classified only as a desktop transport. It does not by itself establish semantic accessibility targeting, verified pointer control, action idempotency, or effect reconciliation.

## Imported production patterns

### Playwright: semantic interaction before pixels

Playwright's actionability checks wait for a unique target that is visible, stable, receives events, and is enabled before acting. Its recommended locators use user-facing semantics such as roles and accessible names, and each locator action resolves against the current DOM rather than preserving a stale element handle. Web-first assertions retry until their condition is satisfied. The interaction harness therefore requires a fresh observation and exact pre-state digest, prefers semantic targets, and treats verification as a distinct phase.

Accessibility/DOM snapshots are action evidence. Screenshots are observational evidence and become an action basis only for an explicitly authorized coordinate fallback. Coordinate actions require exact current viewport dimensions, the exact source observation, in-bounds coordinates, and screenshot evidence from that observation.

Browser contexts and storage state establish useful isolation and continuation patterns, but authentication state can contain sensitive cookies and headers. Checkpoints therefore retain only opaque sensitive-state references and digests, never raw browser credentials.

Playwright traces provide a useful evidence model because they preserve before/after DOM snapshots, logs, screenshots, and network activity. The harness stores bounded evidence references instead of copying complete traces into executor state.

Primary references:

- <https://playwright.dev/docs/actionability>
- <https://playwright.dev/docs/locators>
- <https://playwright.dev/docs/test-assertions>
- <https://playwright.dev/docs/browser-contexts>
- <https://playwright.dev/docs/auth>
- <https://playwright.dev/docs/trace-viewer>
- <https://github.com/microsoft/playwright-mcp>

### MCP: structured contracts, hints are not enforcement

MCP tool results can carry `structuredContent` validated by an output schema. Tool annotations can describe read-only, destructive, idempotent, and open-world behavior, but the specification explicitly treats annotations as hints rather than a security boundary. DevSpace therefore enforces adapter action allowlists, effect class, approvals, idempotency, stale-state checks, and verification in the interaction controller itself. MCP annotations are emitted only as discoverability metadata when the surface is registered.

Primary references:

- <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
- <https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices>

### Remote desktop systems: explicit connection identity and resumable transport

Apache Guacamole demonstrates useful transport-level patterns: explicit connect/disconnect lifecycle, stable connection history, session recording, clipboard/file transfer as separate channels, and the ability for a remote session to continue or be resumed independently of the viewer. These patterns map to an explicit `backendSessionRef`, `contextRef`, bounded evidence references, and recovery that checks whether the binding changed.

Remote Desktop Commander contributes a similar separation: connection lifecycle, remote filesystem, terminal, process, and connected-device operations are explicit tools rather than an implicit pixel stream. Those deterministic channels should remain preferred over GUI interaction whenever they can express the task.

Primary references:

- <https://guacamole.apache.org/doc/gug/recording-playback.html>
- <https://guacamole.apache.org/doc/gug/using-guacamole.html>
- <https://github.com/KiyaNayat/remote-desktop-commander-mcp>

### WebDriver BiDi: stable context and navigation identity

WebDriver BiDi models browsing contexts, navigations, prompts, downloads, and screenshots with stable identifiers and explicit lifecycle events. The interaction binding follows this pattern by separating the adapter session from the current context/tab/window and refusing ordinary continuation when either identity changes.

Primary reference:

- <https://www.w3.org/TR/webdriver-bidi/>

### Durable execution: replay steps, not uncertain external effects

Durable workflow systems recover by replaying recorded deterministic progress and by retrying bounded activities under declared policies. They do not justify blindly repeating an external action whose previous outcome is unknown. The interaction checkpoint therefore records a pending action before dispatch. A process boundary while an action is `acting` or `needs_verification` converts the state to `indeterminate`; the next executor must read back the exact target and reconcile `effect_absent` or `effect_verified` before retrying.

Primary reference:

- <https://docs.temporal.io/workflow-execution>

## Routing policy

The default order is:

```text
API -> shell/native tool -> Playwright semantic target
    -> desktop accessibility -> verified vision/pointer fallback
```

Selection is capability-based, not hard-coded to one provider. An adapter is eligible only when it supports the target kind, observation, verification, required capabilities, and requested session semantics. Vision/pointer control is ineligible unless the caller explicitly authorizes coordinate fallback.

The existing Playwright extension bridge is exclusive because a persistent browser profile or extension-backed browser context cannot safely be driven by competing MCP clients. A live Playwright client therefore produces `exclusive_adapter_busy`; DevSpace must serialize access through one broker instead of spawning another client.

## Interaction lifecycle

```text
needs_observation
    -> ready
    -> acting
    -> needs_verification
    -> verified
```

Exceptional states:

- `held`: a policy or runtime precondition is not satisfied.
- `indeterminate`: an action may have taken effect but no definitive outcome or postcondition proof exists.
- `failed`: a terminal local failure with an understood outcome.
- `cancelled`: local execution stopped; cancellation never erases an indeterminate external effect.

Every ordinary action is bound to:

- execution scope and optional workspace/mission,
- adapter and surface,
- backend session and exact tab/window/context,
- current observation identifier and pre-state digest,
- target strategy,
- an action kind declared in the adapter's explicit allowlist,
- effect class,
- externally verified approval and authority-readback references for mutating actions,
- explicit postconditions,
- idempotency-key digest and request digest.

## Stale-state and effect safety

An action is rejected when its observation ID or pre-state digest does not match the current observation. A semantic target must contain an exact snapshot reference or stable semantic selector. A coordinate target requires proof that semantic targeting was exhausted.

The lightweight in-memory controller is restricted to read-only work. Any reversible or irreversible browser/desktop action must go through the durable broker so the exact pending action is checkpointed before dispatch. Adapters must also declare and enforce bounded operation timeouts; adapters without that contract are ineligible.

Read-only, reversible, and irreversible effects are distinguished. Reversible and irreversible actions require an explicit approval reference, a successful readback from a configured external approval verifier, and at least one postcondition. The caller's `approved` claim is never authority by itself. The verifier contributes bounded verification and authority-readback references to the prepared action; raw credentials or approval-system payloads are not copied into the checkpoint. A reported adapter success enters `needs_verification`; it is not completion.

Each adapter declares an action allowlist and a minimum effect class for every allowed action. The caller may classify an action more strictly but cannot downgrade below the adapter floor. In the existing Playwright candidate, `inspect` is read-only; navigation, click, type, select, download, and window control are at least reversible; upload is at least irreversible. The bridge does not permit raw `execute` or `custom` actions. A future adapter may expose broader operations only after declaring and testing those operations explicitly.

Idempotency keys are payload-bound. Reusing a key with a different request is rejected. A verified retry returns the prior receipt without re-executing. A mutating action may be retried only when readback proved that the previous attempt had no effect and the action was explicitly declared idempotent.

Transport loss after dispatch, failed actions without no-effect proof, verification transport loss, binding changes during verification, and unmet postconditions all become `indeterminate`. Blind replay is prohibited. Exact binding and caller-supplied evidence are necessary but not sufficient to clear that state: a configured external reconciliation verifier must validate `effect_absent` or `effect_verified` against a current authority readback. The checkpoint retains its verification and authority-readback references in a reconciliation receipt before retry or continuation is allowed.

## Checkpoint and recovery

The checkpoint is provider-neutral and serializable. It contains the identity, lifecycle state, exact binding, latest bounded observation, pending action, verification receipt, reconciliation receipt, hold, idempotency ledger, and next-action guidance. It contains evidence references and sensitive-state references rather than raw traces, screenshots, cookies, tokens, or browser profiles.

Evidence, approval, handoff, authority-readback, and sensitive-state references must be bounded opaque URI-like references. Credential-bearing userinfo and credential-like query fields are rejected. Observed browser URLs are normalized to origin and path by removing query and fragment before checkpointing; the state digest and bounded evidence preserve change detection without retaining signed URLs or session-bearing navigation state.

Recovery behavior:

- no observation -> re-observe;
- changed session/context binding -> re-observe;
- coherent verified/ready checkpoint -> continue;
- unsettled action across a process/model boundary -> mark indeterminate and reconcile;
- existing indeterminate effect -> resolve using exact-binding readback;
- cancellation request while indeterminate -> reject because local cancellation cannot resolve an external effect.

## Runtime probe

`probeZesInteractionRuntime()` reports the fixed existing GUI and Playwright topology and classifies adapters without starting a new browser or MCP client. It checks:

- XRDP service state;
- X11 socket `/tmp/.X11-unix/X10`;
- Xorg/Cinnamon process presence;
- fixed Playwright wrapper and binary executability;
- readability of the fixed credential reference without reading its value;
- output-directory presence and ownership;
- browser and Playwright process counts;
- wrapper SHA-256.

The probe distinguishes:

- GUI transport ready;
- existing Playwright extension runtime reusable;
- exclusive Playwright client busy;
- desktop transport present but no accessibility adapter;
- desktop transport present but no verified pointer adapter.

## Activation stages

### Stage 1 — control core and read-only probe

Implemented in this candidate:

- provider-neutral routing and lifecycle;
- stale-state, approval, idempotency, and postcondition policy;
- fail-closed recovery and effect reconciliation;
- serializable checkpoints;
- fixed live-runtime probe;
- focused behavioral tests.

### Stage 2 — one durable Playwright broker

The provider-neutral broker contract is implemented in this candidate. It serializes an adapter with an expiring lease, uses compare-and-swap checkpoint persistence, saves `acting` before dispatch, saves outcome and verification after dispatch, blocks an externally busy adapter, and supports explicit execution-scope adoption with a handoff and authority-readback reference. Cross-scope adoption is not authorized by caller-supplied references alone: a configured external adoption verifier must validate the exact prior scope, target scope, handoff, and authority readback, and its verification reference is retained in scope lineage.

An unsettled durable checkpoint is recovered as `indeterminate`. A failed pre-dispatch write restores the last durable checkpoint and performs no action. A failed post-dispatch write fences the broker, releases its lease when possible, and leaves the durable `acting` checkpoint for the next broker to recover and reconcile rather than allowing the current process to continue from ambiguous state. Before an observation, action, or verification, the broker renews the adapter lease beyond the operation's declared timeout plus a safety margin. The adapter is required to enforce that timeout; this prevents the ordinary lease from expiring while a long interaction is still in flight.

The durable store is now implemented in the existing DevSpace SQLite/WAL database. Lease claims, renewals, release tombstones, monotonic fencing generations, and checkpoint compare-and-swap are shared across database handles. Interaction payload text is not part of the store contract; persisted actions retain only bounded metadata and payload digests.

The first production adapter seam is intentionally narrow: the fixed internal Conversation Transport `web_ui` wake actuator is wrapped by the durable broker. The broker owns the one shared Playwright serialization lease and saves `acting` before the privileged bridge may compose or submit. The bridge continues to use the already registered App Server-mediated Playwright connection and does not launch a competing extension client. Native RPC remains direct-first and does not create a browser broker checkpoint.

An indeterminate Web UI wake is reconciled in the same SQLite transaction as the upper wake attempt and durable host-turn lifecycle. Exact effect-absent readback returns the broker checkpoint to `ready`; exact effect-verified readback advances it to `verified`. Neither path permits blind replay.

### Stage 3 — read-only MCP registration and durable store

The durable store is present through the normal migration surface and is used by the fixed Conversation Transport wake path. A general `zes_interaction_runtime_status` projection remains a separate additive surface. Do not expose general-purpose action tools until process-boundary, lease-contention, restart, and indeterminate-effect recovery tests pass against every production adapter. The internal Web UI wake actuator does not make raw Playwright execution, arbitrary selectors, or browser credentials callable from MCP.

### Stage 4 — browser action surface

Expose bounded semantic browser operations through the broker. Keep raw Playwright code execution and arbitrary selectors disabled by default. Attach MCP output schemas and truthful annotations, while enforcing policy in the controller.

### Stage 5 — native desktop adapters

Prefer an accessibility-tree adapter for Cinnamon/X11 applications. Add verified screenshot/pointer control only for applications that cannot expose a deterministic interface. Pointer actions remain fallback-only and use the same observation, verification, evidence, approval, idempotency, and recovery contracts.

## Non-goals

- Rebuilding XRDP, Cinnamon, Chromium, or Playwright.
- Making Playwright state a canonical ZES truth plane.
- Saving raw credentials, cookies, or extension tokens in interaction checkpoints.
- Treating a screenshot or successful click dispatch as proof of completion.
- Starting multiple clients against the same persistent browser session.
- Retrying an unknown external effect because an executor restarted.
- Using remote desktop interaction where API, shell, MCP, accessibility, or semantic browser control is available.

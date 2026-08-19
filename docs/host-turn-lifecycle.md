# Durable Host-Turn Lifecycle

DevSpace coordinates long-running work across execution scopes, conversation
transports, and provider turns. These identities are related, but they are not
interchangeable:

- an **execution scope** is the MCP host conversation/task address used by
  DevSpace tools;
- a **conversation binding** identifies one allowlisted provider or WebChat
  target without persisting its raw URL, thread ID, or credential;
- a **host turn** is one provider/UI generation boundary on that target;
- a **wake attempt** is an executor-local scheduling/effect attempt intended to
  start a new host turn.

Tool inactivity does not identify a host-turn boundary. A model may be
reasoning or a provider stream may remain open while no MCP call is visible.
Conversely, a server-side tool may be idle while a browser page has failed.
DevSpace therefore never derives `completed`, `failed`, `cancelled`,
`awaiting_input`, or `hung` from an MCP observation gap.

## Authority boundary

The host-turn lifecycle is executor-local observation and recovery state. It
does not own canonical work, accepted decisions, writer leases, external effect
outcomes, publication, provider control, browser control, or interaction
ownership. The Interaction Broker remains the sole owner of browser/process/UI
action serialization. Conversation Transport remains the sensor/actuator.

The lifecycle store persists only opaque references, digests, timestamps,
state transitions, and bounded evidence references. It does not require or
store raw prompts, transcripts, private reasoning, cookies, URLs, credentials,
or arbitrary provider identifiers.

## Durable model

Each `(targetExecutionScopeRef, missionRef)` has one lifecycle session bound to
an exact conversation binding and binding generation. The session points to a
monotonic host-turn generation. Each turn records:

- target execution scope and mission;
- conversation binding reference and generation;
- provider adapter, opaque provider session/turn refs when available;
- generation-boundary reference;
- `startedAt`, `endedAt`, state revision, and evidence expiry;
- work-cycle, correlation, pending-work, and wake-permit refs when applicable;
- evidence, authority-readback, effect-readback, and reason refs.

Supported states are:

```text
awaiting_input
started
running
completed
failed
cancelled
disconnected
indeterminate
```

Only `awaiting_input`, `completed`, `failed`, and `cancelled` are wake-eligible,
and only while their explicit evidence remains fresh. `started` and `running`
always block a wake. `disconnected` and `indeterminate` block a wake until
reconciliation. Advisory evidence cannot create a wake-eligible state.

Terminal or awaiting-input evidence must come from an explicit host edge, such
as Conversation Transport, a provider adapter, the browser supervisor, or a
verified reconciliation. It must carry an evidence reference, authority
readback, confidence, and termination cause. Silence is not such evidence.

## Conversation Transport seam

The upper wake scheduler and lower transport use one immutable
`HostTurnWakeGateBinding`:

```text
sessionRef + sessionRevision
conversationBindingRef + generation
hostTurnRef + generation + revision
state + stateDigest
generationBoundaryRef
evidenceDigest + evidenceRefs
authorityReadbackRefs
expiresAt
```

This snapshot is included in the wake key and persisted wake permit. It prevents
one permit from being replayed against a later host-turn generation, a changed
binding, or refreshed-but-different lifecycle state.

The effect path is:

```text
durable pending work
  -> transport status and deterministic route
  -> explicit host-turn observation
  -> fresh wake-eligible gate
  -> upper wake lease and persisted permit
  -> post-lease assessment
  -> lower pre-dispatch route/lifecycle/gate readback
  -> bridge effect lock and route/lifecycle readback
  -> persist delivery outcome
  -> persist new host-turn generation
```

Both the TypeScript lower plane and the privileged bridge fail closed if the
provider becomes active, the route changes, the binding changes, or lifecycle
evidence becomes stale before dispatch. Tier 1 still authorizes only one
correlated continuation. It does not stop generation, regenerate, reload,
navigate away, open a duplicate conversation, publish, or repeat another
external effect.

## Outcome and reconciliation semantics

A verified delivery must provide prompt admission and a new generation
boundary. The lifecycle then records a new `started` turn tied to the exact
wake permit and provider turn reference.

A proven no-effect delivery leaves the prior wake-eligible turn unchanged and
the upper scheduler applies cooldown/backoff.

Transport loss, partial delivery, an unknown provider outcome, or failure to
durably record the new host turn after delivery creates `indeterminate` state.
Neither the scheduler nor Conversation Transport may retry that work blindly.
Reconciliation must provide authority and effect readbacks:

- `effect_absent` closes the turn as `cancelled` and permits a later bounded
  retry after scheduler policy allows it;
- `effect_verified` restores the turn as `running` with the verified generation
  boundary, so a second wake remains blocked.

The scheduler and lifecycle share one SQLite transaction boundary in the
Conversation Transport runtime. A reconciliation cannot advance one state
machine while leaving the other unreconciled.

## Adapter mapping

Conversation Transport maps only explicit lifecycle values. Examples:

- `idle`, `responsive_idle`, `awaiting_input`, `ready` -> `awaiting_input`;
- `active`, `running`, `generating`, `streaming`, `thinking` -> `running`;
- `completed`, `succeeded`, `task_complete` -> `completed`;
- `failed`, `systemError`, `terminal_error` -> `failed`;
- `cancelled`, `interrupted`, `aborted` -> `cancelled`;
- `disconnected`, `page_frozen`, `page_discarded` -> `disconnected`.

Unknown, missing, or unrecognized lifecycle values do not update the durable
state and cannot authorize a wake. Provider-specific vocabulary stays at this
adapter edge; the durable model remains provider-neutral.

## Observability

Existing status tools expose the lifecycle as an additive projection:

- `conversation_transport_status` joins current binding, route, lower-plane
  readiness, and host-turn lifecycle;
- `execution_wake_status` joins pending work, attempts, throttle, lease, and
  host-turn lifecycle.

No new browser-control or lifecycle-effect tool is introduced. The projection
is read-only and retains the same executor-local authority ceiling.

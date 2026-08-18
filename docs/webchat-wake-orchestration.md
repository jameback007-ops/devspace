# WebChat cross-session wake orchestration

Status: isolated lower-plane candidate. No MCP registration, persistent store,
Playwright process ownership, deployment, or autonomous wake is enabled by this
document or its sibling source file.

## Purpose

The WebChat supervisor closes a specific gap between durable A2A coordination
and an existing ChatGPT Web conversation. A coordination task can remain
pending while the target WebChat turn has ended and is waiting for user input.
The supervisor provides the evidence and interaction contracts needed to wake
that exact conversation without treating ordinary MCP silence as proof that a
model or provider is hung.

The capability is deliberately split into two authority planes:

- The A2A coordination plane owns pending-work semantics, durable wake leases,
  cooldowns, attempt limits, task/thread correlation, orphan adoption, and the
  decision to issue a wake permit.
- The interaction plane owns exact browser binding, read-only operational
  observation, classification, permit consumption, Playwright interaction
  preparation, persist-before-dispatch execution through `InteractionBroker`,
  and post-submit effect verification.

Neither plane gains canonical task, decision, writer, effect-outcome, memory,
or publication authority from these contracts.

## Observation ceiling

The browser client cannot read hidden model reasoning. No supported signal can
prove whether an unobservable provider is internally reasoning, queued, or
hung. The supervisor therefore reports operational states only. In particular:

```text
MCP silence != idle
MCP silence != reasoning
MCP silence != provider generation
MCP silence != hang
```

An ordinary wake is possible only after two coherent, recent, responsive-idle
samples from the exact bound page. All incomplete or contradictory evidence
becomes `unknown` and holds.

## Evidence planes

One `WebChatObservationSample` combines bounded evidence from four planes under
one observation time window:

1. Executor evidence: running MCP tools, running processes, the latest MCP
   activity boundary, and unsettled interaction state.
2. Browser evidence: browser/context/target identity, crash or close state,
   page lifecycle, discard restoration, heartbeat responsiveness, and online
   status.
3. UI evidence: exact conversation digest, versioned selector-contract result,
   composer state, send/stop/retry controls, generation/error indicators,
   message counts, and message-content digests rather than message text.
4. Network evidence: generation request state and bounded timestamps for HTTP
   stream bytes, WebSocket frames, EventSource messages, request completion,
   and request failure. Network absence is not conclusive when Service Workers
   may hide events.

The operational classifier distinguishes:

| State | Meaning | Wake disposition |
| --- | --- | --- |
| `executor_active` | Tool, process, or unsettled interaction is active | hold |
| `ui_streaming` | Generation UI plus recent DOM/output/transport progress | hold |
| `provider_pending` | Generation remains indicated, but progress is not currently observed | hold |
| `generation_stalled_suspected` | Repeated responsive UI with no request or progress under complete observation | advisory hold only |
| `responsive_idle` | Exact page is responsive and idle in two coherent samples | Tier 1 only when the composer is empty |
| `terminal_error` | Explicit generation error or account/login boundary | Tier 2 review or manual intervention |
| `page_frozen` | Browser lifecycle froze the page | hold |
| `page_discarded` | Page was restored after browser discard | rebind |
| `ui_unresponsive` | Target exists but the page heartbeat fails | recovery review |
| `browser_or_network_failed` | Browser, target, renderer, or network is unavailable | repair transport |
| `unknown` | Evidence is stale, incomplete, contradictory, or drifted | fail closed |

`generation_stalled_suspected` is not a hidden model-state claim and never
authorizes a wake by itself.

## Exact session binding

`WebChatSessionUiBinding` joins one execution scope to one existing WebChat
conversation and one browser target:

```text
execution scope
  + mission reference
  + browser context reference
  + target reference
  + page reference
  + conversation URL digest
  + conversation identity digest
  + selector contract digest
  + binding epoch
  + external binding proof references
```

The raw conversation URL is not stored. Both the browser context and page
reference must match the underlying `InteractionBinding`. Missing URL or
conversation digests are not accepted as an exact binding. Navigation,
discard, page replacement, account/project mismatch, or selector-contract
drift requires a new binding epoch.

## Selector contract

The ChatGPT Web DOM is not treated as a stable public API. The adapter must
present a versioned semantic selector contract with exact target refs for the
composer, replace/fill operation, send control, and message list. The contract
must resolve every required target exactly once. Ambiguity, missing targets, or
digest drift quarantines the adapter instead of falling back to guessed CSS or
screen coordinates.

Playwright user-facing locators and actionability checks are preferred. Forced
actions and coordinate fallback are prohibited for Tier 1 wakes.

## Durable permit boundary

The lower plane never authorizes a wake from caller-supplied references alone.
The A2A plane must issue a bounded `WebChatWakePermit` containing:

- issuer and target execution scopes;
- pending message/work readback references;
- optional task, thread, and correlation references;
- exact binding ref, epoch, and conversation URL digest;
- exact observation-state and classification digests;
- durable wake-lease ref and idempotency key;
- attempt/max-attempt values and a short issuance/expiry window;
- authority-state readback references.

Consumption also requires a configured `WebChatWakePermitVerifier`. It must
read current coordination/lease authority and return bounded verification and
authority-readback references. A permit object is never authority by itself.

## Tier 1 interaction sequence

The ordinary wake path is deliberately two-phase:

```text
A2A pending work
  -> read exact SessionUiBinding
  -> collect coherent observation window
  -> classify responsive_idle with empty composer
  -> acquire durable A2A wake lease
  -> issue externally verifiable wake permit
  -> acquire the single InteractionBroker adapter lease
  -> observe exact browser binding
  -> prepare reversible composer replacement
  -> persist action before dispatch
  -> type correlated mailbox-first envelope
  -> verify exact staged text digest
  -> observe staged composer again
  -> prepare irreversible send click
  -> persist action before dispatch
  -> submit
  -> verify exact user-message admission
  -> verify a generation boundary newer than submit preparation
  -> persist wake receipt or reconcile an indeterminate effect
```

The wake envelope contains correlation refs only. It instructs the target to
read `execution_scope_message_inbox` and reconcile current workspace,
authority, effect, and recovery state before continuing. Task content remains
in the durable coordination/mailbox system rather than being copied into an
ad-hoc UI prompt.

The compose text is supplied to the adapter through an expiring
`WebChatEphemeralWakePayload`. The durable interaction checkpoint contains only
its digest and opaque refs. The payload must match the exact prepared compose
action, permit, binding epoch, and validity window.

## Effect reconciliation

Composer replacement is reversible. Sending the prompt is irreversible and is
declared non-idempotent. A transport loss after submit, cleared composer without
an admitted matching user turn, selector drift, or unavailable page readback
becomes indeterminate. It must not be replayed.

Successful verification requires both:

1. the user-turn count advanced and the latest user-message digest equals the
   exact wake-envelope digest; and
2. a new assistant placeholder/turn, generation indicator, stop control, or
   generation request started after submit preparation.

Message admission without a generation boundary is retained as a distinct
non-terminal state. A staged envelope still present with an unchanged user-turn
count is bounded proof of no admission. All other ambiguous results require
exact-binding reconciliation through `InteractionBroker`.

## Recovery tiers

- Tier 0: mailbox delivery only. No browser action.
- Tier 1: submit one correlated continuation prompt to a proven responsive-idle
  exact conversation.
- Tier 2: review an explicit terminal generation error. The current lower-plane
  contract does not authorize Retry, Regenerate, Stop, or Reload.
- Tier 3: repair a frozen, discarded, crashed, closed, or disconnected browser
  target, then establish a new binding and reobserve. Not implemented here.
- Tier 4: A2A orphan adoption or replacement-session continuation using a fresh
  recovery capsule and explicit lineage. Owned by the coordination plane.

The current candidate contains no builders for Stop, Regenerate, Reload,
duplicate-chat creation, login, CAPTCHA handling, or account-warning bypass.

## Concurrency and deployment

The live VPS currently has one visible XRDP/Xorg/Cinnamon session and an
existing Playwright extension bridge used by Codex. That bridge is exclusive.
DevSpace must route through one broker-owned adapter lease rather than starting
a competing Playwright client.

Activation order after shared-surface reconciliation:

1. integrate the interaction candidate with the current DevSpace main;
2. implement the existing-DB `InteractionBrokerStore` and migrations;
3. add read-only binding/runtime/classification status tools;
4. bind one broker-owned Playwright observer without action activation;
5. validate selector drift, lifecycle, crash, and network evidence on a safe
   non-mutating fixture;
6. activate reversible composer staging in a test conversation;
7. activate irreversible Tier 1 submit only after durable A2A permit/lease and
   end-to-end reconciliation tests pass.

## Research basis

The design was checked against primary upstream material on 2026-08-18:

- Playwright actionability and auto-waiting:
  <https://playwright.dev/docs/actionability>
- Playwright locator resilience and fresh element resolution:
  <https://playwright.dev/docs/locators>
- Playwright network and WebSocket observation:
  <https://playwright.dev/docs/network>
- Chrome Page Lifecycle API, including freeze/resume and discard restoration:
  <https://developer.chrome.com/docs/web-platform/page-lifecycle-api>
- Chrome DevTools Protocol Target and Page lifecycle events:
  <https://chromedevtools.github.io/devtools-protocol/tot/Target/>
  <https://chromedevtools.github.io/devtools-protocol/tot/Page/>
- WebDriver BiDi browsing-context and navigation identity:
  <https://www.w3.org/TR/webdriver-bidi/>

These sources provide browser and automation evidence. They do not expose
ChatGPT's hidden model reasoning state; the supervisor preserves that boundary.

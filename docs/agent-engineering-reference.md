# DevSpace Agent Engineering Reference

Read this reference selectively when a change crosses MCP schemas, workspace or
instruction loading, skill discovery, process/subagent lifecycle, persistence,
packaging, deployment, security, or host-visible behavior. It expands the
mandatory `AGENTS.md`; it does not replace it.

## Terms

- **Host** — the MCP client presenting the agent experience and coordinating
  work.
- **Server** — the local DevSpace MCP server.
- **Workspace** — one opened checkout or managed worktree plus executor-local
  state and instruction context.
- **`workspaceId`** — the opaque handle returned by `open_workspace` and reused
  for later operations.
- **Allowed root** — a configured filesystem boundary in which a workspace may
  be opened. It is not itself necessarily a workspace.
- **Checkout mode** — work in an existing checkout supplied by the user.
- **Worktree mode** — work in a managed isolated Git worktree.
- **Tool surface** — a configured set of tools such as minimal, full, or
  Codex-compatible.
- **Process session** — a long-running command tracked for later polling, input,
  resizing, or termination.
- **Execution scope** — a stable provider-neutral host conversation/task scope
  joining workspace, process, mailbox, and bounded audit observations. It is
  not a transcript or product authority.
- **Unmaterialized current scope** — a host-supplied stable execution-scope
  identity that has not yet produced an audited executor event. Inspection may
  project it read-only, but it is not evidence that executor capability is
  absent and inspection alone must not create durable audit state.
- **Turn horizon** — advisory assistant-turn timing derived from exact host
  metadata, an explicit begin call, or the first non-control tool in an
  implicit epoch. It never blocks tools or limits a task.
- **Turn instability assessment** — a bounded classification of sanitized tool,
  process, capsule, effect, and backend lifecycle evidence as normal, degraded,
  unstable, or critical. It is guidance, not hang detection or authority.
- **Operational landing envelope** — a persisted bounded machine envelope for
  one scope/turn epoch containing safe lifecycle IDs, timing, checkpoint,
  backend, and effect-disposition facts. It excludes semantic inference,
  prompts, output, commands, paths, credentials, and private reasoning.
- **Recovery capsule** — a bounded semantic executor handoff bound to current
  Git state. It is not canonical task, decision, writer, effect, publication,
  or memory authority.
- **Semantic execution status** — a read-only join of one scope's latest
  explicit recovery capsule with live workspace/process/tool observations. It
  does not infer hidden model state or create a second semantic store.
- **Observation gap** — elapsed time since the last observed MCP/tool event.
  It is not evidence that the model is idle, reasoning, generating, or hung.
- **Backend tool-surface fingerprint** — a read-only SHA-256 digest over the
  tools actually registered by the current DevSpace backend, including their
  model-facing schemas and safe configuration. It does not expose or attest the
  MCP client's cached tool catalog.
- **Stable control-plane projection** — an additive read-only capability
  envelope returned inside the existing `execution_scope_status` data payload.
  It lets a client with a frozen tool catalog read fixed server-owned control
  state without first discovering a newer top-level tool. It does not refresh
  the host catalog or grant task, writer, effect, publication, or takeover
  authority.
- **Local-agent turn** — one queued provider prompt serialized by a worker
  lease. It is not canonical work or effect authority.
- **Worker lease** — an executor-local single-worker claim. Expiry after
  provider execution began creates an indeterminate turn rather than permission
  to replay.
- **Execution message** — a target-bound executor-local envelope with
  idempotent send and monotonic receipts. It is not task, decision, writer,
  effect, checkpoint, or canonical-memory authority.
- **Instruction file** — an `AGENTS.md` or `CLAUDE.md` loaded initially or
  advertised for a nested path.
- **Skill** — a lazy procedure selected by metadata and read only when relevant.
- **Subagent** — a bounded model invocation coordinated by the host.
- **Agent profile** — provider, model, tools, and instructions for a subagent.
- **Artifact** — an output surfaced for host or user inspection.
- **Review checkpoint** — stored state for one coherent aggregate diff.
- **Widget** — host-rendered UI attached to an MCP response.

Use these terms precisely. In particular, do not use workspace, allowed root,
checkout, and worktree interchangeably.

## Diagnose the correct layer

A failure can belong to the host UI, OAuth, MCP transport, DevSpace server, a
Pi adapter, a provider, a model, a tool implementation, the operating system,
or the target project. Preserve the original error and identify the failing
boundary before changing code.

Examples:

- A provider adapter exception does not establish model failure.
- A healthy optional Codex App Server adapter does not establish that a thread
  is healthy, and a degraded thread does not establish DevSpace/VPS failure.
- A successful shell command does not establish that a GUI opened or a host
  refreshed.
- A process PID alone is not writer or effect authority.

## Trace affected contracts

Check the surfaces the change actually reaches:

- MCP schema, annotations, description, handler, and returned payload;
- workspace creation, restore, checkout reuse, and managed worktrees;
- root/path containment and external read gates;
- initial and nested instruction loading;
- skill discovery, exposure, search, activation, and referenced-file access;
- process lifecycle and pure polling;
- subagent provider availability, queues, leases, cancellation, and recovery;
- execution-scope observability and messaging;
- advisory turn continuity and recovery-capsule persistence/freshness;
- widgets, artifacts, and review checkpoints;
- SQLite schema, migration, retention, and restart recovery;
- package entry points, documentation, examples, and generated assets;
- source checkout versus installed package and live service restart.

This is a routing map, not a requirement to touch every surface on every change.

## Verify the real path

Behavior may differ across:

- source checkout and packaged `npm`/`npx` installation;
- direct terminal client and a real MCP host;
- fresh process and a host/server retaining an old schema;
- checkout and worktree modes;
- Linux, macOS, and Windows Bash environments;
- minimal, full, and Codex-compatible tool surfaces;
- widgets off, changes-only, and full;
- local unit tests and the deployed public endpoint.

For model-facing changes, inspect the schema and the actual structured response.
Use the backend tool-surface fingerprint to distinguish a changed server schema
from a host that still presents an older cached catalog; the server cannot
observe client catalog freshness directly. For OpenAI's stateless request path,
assume discovery and execution may be separated across backend restarts: avoid
repeated deployment restarts, expose no-store/fingerprint/epoch evidence, and
refresh or reconnect the host when required sentinel tools are missing.

Critical read-only control state must not depend exclusively on discovery of a
new top-level tool. Project it through the stable `execution_scope_status`
bootstrap envelope when all of the following hold: the route is fixed and
server-owned, accepts no arbitrary path or credentials, has a bounded typed
result, and cannot itself perform the governed effect. Keep the direct tool for
fresh clients, but treat the embedded projection as the compatibility path for
older catalogs. Add fields only inside the existing open `data` payload, return
explicit `available` or `unavailable` state, suppress raw runtime diagnostics,
deduplicate concurrent refreshes, and keep any cache short and advisory. A
missing or stale client catalog is a transport/discovery condition; it must not
be converted into evidence that a writer exists, that publication controls are
absent, or that any governed action is authorized.

Repository publication uses one mandatory repository-local fast gate plus
optional consequence-specific gates. The mandatory gate reads the fixed remote
and branch identity, obtains fresh remote `main` with `git ls-remote`, binds one
internally registered candidate workspace or preservation ref to its exact clean
HEAD, verifies ancestry, zero-behind/no-merge history, and checks that an
existing validation receipt still matches that exact HEAD and dirty-state
fingerprint. A local `origin/main` ref, branch tracking configuration,
`push.default`, or a candidate-local hook may provide diagnostics or defense in
depth, but none is remote authority when the fixed effect accepts no target
inputs and pushes one exact SHA refspec. Likewise, a stale or degraded unrelated
Codex/AOQ thread is not evidence that this repository candidate has an active
writer. Never accept an arbitrary model-supplied workspace, repository, remote,
branch, URL, refspec, credential, or expected-old value.

Reuse an immutable HEAD-bound validation receipt while candidate identity and
dirty state remain unchanged; do not rerun the full validation suite merely to
recreate the same evidence. Any candidate mutation invalidates the plan and its
receipt binding. Invoke runtime-service and deployment readiness only when the
changed paths require a runtime or release follow-up. Invoke material-effect
reconciliation only when the candidate declares an exact effect key and that
effect is unresolved. Once the candidate is eligible, enter publication-only
terminal mode: no new research or feature expansion is allowed unless a
reproducible defect is itself publication-blocking.

`execution_scope_status` may return the global continuation projection as
`deferred` while a repository candidate is on this fast path. That state means
no automatic multi-owner runtime refresh was started because it cannot change
the repository publication decision. Invoke the fixed direct continuation tool
only for governed-checkout mutation, runtime deployment/takeover, runtime-state
reliance, or exact material-effect reconciliation. The embedded advisory cache
is bounded and never substitutes for those pre-effect readbacks.

The effect gate serializes publication with a repository-local lease, requires
the unchanged plan digest, rereads remote `main`, pushes the exact candidate SHA
with an expected-old force-with-lease binding, and derives terminal outcome from
a second remote readback. The authoritative remote readback is the publication
effect boundary. Updating local remote-tracking or governed-checkout mirrors is
a residual reconciliation and must never turn a verified remote publication
back into failed or unknown state. Replaying a completed plan returns its
terminal receipt without pushing again. Preflight and effect receipts should
report per-stage duration plus evidence that was required or deliberately
skipped as irrelevant, so safety cost and ceremony remain inspectable.

For UI or artifacts, inspect rendered output rather than inferring success from
the producing command. State clearly when only a narrower proxy was verified.

## Pull requests

Create or update a PR only when requested. Read `CONTRIBUTING.md`, use a focused
conventional title, explain the problem and solution in natural paragraphs, and
include verification or risk only when useful. Avoid generated boilerplate,
commit inventories, and file-by-file narration. For UI behavior changes, include
appropriate visual evidence when the workflow supports it.

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
  metadata or one explicit begin call. It never blocks tools or limits a task.
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

Repository publication needs two distinct readbacks. The fixed ZES continuation
projection supplies global rightful-owner state and the authoritative remote
`main` commit; it may correctly report `publication_disposition=not_required`
for the governed checkout even when another linked worktree contains an
unpublished candidate. The scope-publication projection must separately bind
that global state to an internally registered execution-scope workspace, verify
repository identity, exact branch/remote/merge target, candidate ancestry,
cleanliness, fail-closed publication controls, and a fresh recovery capsule whose
passed validation is bound to the exact candidate HEAD. Only that combined
assessment may describe the candidate as eligible, and even then it returns a
compare-and-swap expectation plus remote-readback requirement rather than
performing the push or granting publication authority. The capsule validation
claim is executor-local evidence, not publication authority; the effect gate
must rerun or independently revalidate the required validation and all Git,
writer, authority, hook-identity, and remote-main bindings immediately before
the push. Never accept an arbitrary model-supplied workspace path for this
projection, and never treat a local `origin/main` ref as remote authority
without the fixed product readback.

For UI or artifacts, inspect rendered output rather than inferring success from
the producing command. State clearly when only a narrower proxy was verified.

## Pull requests

Create or update a PR only when requested. Read `CONTRIBUTING.md`, use a focused
conventional title, explain the problem and solution in natural paragraphs, and
include verification or risk only when useful. Avoid generated boilerplate,
commit inventories, and file-by-file narration. For UI behavior changes, include
appropriate visual evidence when the workflow supports it.

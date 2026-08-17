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
For UI or artifacts, inspect rendered output rather than inferring success from
the producing command. State clearly when only a narrower proxy was verified.

## Pull requests

Create or update a PR only when requested. Read `CONTRIBUTING.md`, use a focused
conventional title, explain the problem and solution in natural paragraphs, and
include verification or risk only when useful. Avoid generated boilerplate,
commit inventories, and file-by-file narration. For UI behavior changes, include
appropriate visual evidence when the workflow supports it.

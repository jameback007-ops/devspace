# DevSpace

DevSpace is a local development execution layer for MCP hosts such as ChatGPT
and Claude. It exposes workspace-scoped file, process, Git, review, artifact,
and bounded subagent capabilities while keeping local authority explicit.

These instructions are the mandatory repository baseline. Read nested
`AGENTS.md` or `CLAUDE.md` files before changing files in their scope. Do not
load every document or skill pre-emptively: use the relevant repository-local
skill when its description matches, and use `skill_search` only for a
specialized host capability that was not listed automatically.

## Product invariants

1. **The host orchestrates.** DevSpace exposes clear, composable capabilities
   and inspectable state. It does not hide the workflow in an opaque agent loop.
2. **Work happens in a workspace.** A workspace is one checkout or managed
   worktree plus its instructions and executor-local state. Reuse its
   `workspaceId`.
3. **Local authority is explicit.** Approved roots, paths, commands, processes,
   credentials, destructive operations, and external effects are product
   boundaries.
4. **Adapters stay at the edges.** MCP hosts, Pi, and model providers may keep
   their native behavior, but provider-specific representation must not become
   the core domain model.
5. **Subagents are bounded workers.** Their task, profile, context, lifecycle,
   result, cancellation, and uncertain outcomes must remain inspectable.
6. **Prefer reliable primitives.** Give the model meaningful choices; keep
   mechanical routing, validation, and compatibility details inside tooling.

## Executor machinery and product authority

Capability overlap is allowed. Authority duplication is not.

DevSpace may own rich executor-local machinery—workspace/session state, queues,
replay, checkpoints, process and effect-attempt tracking, retries, receipts,
resumption, and recovery—when it improves execution quality. That state must
remain scoped to operating or safeguarding the executor. It must not silently
become canonical product work, accepted decisions, identity, durable business
effects, release state, canonical memory, or writer ownership.

Prefer clean ownership and explicit integration over weakening the executor for
architectural purity.

## Security and failure boundaries

- Filesystem tools enforce approved-root containment. Shell commands run with
  the local user's authority and are not a general sandbox.
- Resolve paths before destructive actions. Do not broaden an allowed root,
  expose credentials, delete state, or replace a process as a convenient fix.
- Keep tunnel lifecycle and credentials with the user.
- Preserve the original failure and identify whether it belongs to the host,
  MCP transport, DevSpace, an adapter, provider, model, tool, or target project.
- An adapter error is not proof that the model failed. A successful command is
  not proof that a GUI, host refresh, or user-visible workflow succeeded.

## Change discipline

Start at the boundary named by the problem and follow the data. Keep policy in
DevSpace, provider translation in adapters, and important behavior in schemas,
types, checks, persistence, or explicit tool results rather than hidden prompt
conventions.

For cross-cutting changes to MCP schemas, workspace/instruction/skill loading,
process or subagent lifecycle, persistence, packaging, or deployment, read the
`devspace-product-change` skill and the selective reference it names. Trace only
the contracts actually affected; avoid both incomplete fixes and speculative
edits.

Preserve unrelated user changes. Add compatibility behavior only for a known
consumer with an explicit upgrade path. Do not turn a local symptom into a new
DevSpace responsibility without a product decision.

## Verification

Verify the path the user will actually consume. Source checkout, packaged
installation, fresh server, existing host connection, checkout/worktree mode,
tool mode, OS, and widget mode may behave differently.

Use the narrowest relevant tests while editing. Before closure, normally run:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Inspect model-facing tool schemas and returned payloads when they change. For a
deployed service, verify the real endpoint after restart; do not infer live
success from a local build.

## Repository map

- `src/server.ts` — MCP setup, tool registration, instructions, and responses.
- `src/workspaces.ts` — workspace lifecycle, instructions, skills, and profiles.
- `src/skills.ts` — skill discovery, contextual exposure, search, and read gates.
- `src/roots.ts` — allowed roots and path containment.
- `src/process-sessions.ts` — long-running process lifecycle.
- `src/local-agent-*.ts` — subagent providers, queues, leases, and continuation.
- `src/artifact-*.ts`, `src/incoming-artifacts.ts` — artifact handling.
- `src/review-checkpoints.ts` — aggregate change-review state.
- `src/ui/` — MCP widgets.
- `src/db/` — persisted local state and migrations.
- `docs/agent-engineering-reference.md` — conditional glossary and contract map.

Only create or update a pull request when explicitly requested. Read
`CONTRIBUTING.md` first and keep the change focused.

---
name: devspace-product-change
description: Use when changing DevSpace MCP schemas, workspace or instruction loading, skill discovery, process or subagent lifecycle, persistence, packaging, deployment, or another host-visible cross-cutting product contract.
x-devspace:
  exposure: contextual
  workspace-markers:
    - package.json
    - src/server.ts
    - src/workspaces.ts
---

# DevSpace Product Change

Use this procedure for cross-cutting DevSpace work. Do not use it for a narrow
single-file change whose affected contract is already obvious.

## Establish the boundary

1. Read the repository `AGENTS.md` and the relevant portion of
   `docs/agent-engineering-reference.md`.
2. Identify the real consumer: source checkout, packaged CLI, MCP host, widget,
   local-agent worker, or deployed service.
3. Preserve the original failure and classify its layer before expanding scope.

## Trace the contract

Follow the changed concept through only the surfaces it reaches:

- model-facing schema, annotations, description, handler, and response;
- workspace creation/restore and checkout/worktree behavior;
- instruction or skill discovery, exposure, activation, and read gates;
- process, queue, lease, cancellation, and restart behavior;
- persistence, migration, retention, and observability;
- package scripts, docs, examples, and live deployment path.

Keep provider translation at adapters. Keep policy and authority boundaries in
DevSpace. Do not encode important behavior only in prompt wording.

## Implement and verify

- Use normal file tools for changes; do not write source through shell
  redirection or generated scripts.
- Add behavioral tests at the boundary being changed, including negative or
  stale-state cases where material.
- Run the narrow relevant tests while iterating, then run `npm run typecheck`,
  `npm test`, `npm run build`, and `git diff --check` before closure.
- Inspect the actual MCP tool list/schema and structured result when model-facing
  behavior changes.
- Restart and probe the real endpoint only when deployment is part of the task.
  A local build alone is not a deployment claim.

Report the exact evidence ceiling and any path not exercised.

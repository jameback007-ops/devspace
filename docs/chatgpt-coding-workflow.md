# ChatGPT Coding Workflow

DevSpace brings a Codex-style coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

ChatGPT should call `open_workspace` once for a project folder:

```json
{
  "path": "~/work/my-project"
}
```

The result includes a `workspaceId`. All later file, search, edit, show-changes,
and shell calls should reuse that same `workspaceId`.

ChatGPT may support automatic checkout recovery through optional host
conversation metadata. This is an OpenAI-host adapter detail, not a standard MCP
conversation field. When that optional context is available, opening the same
checkout project again in the same conversation can continue in the existing
workspace, and the context already provided for that reused checkout is not
repeated. The portable workflow remains the same: keep using the `workspaceId`
returned by `open_workspace` for later operations. Hosts without supported
conversation context receive a normal new workspace and continue with that
explicit `workspaceId` workflow.
The model receives actionable workspace instructions; automatic-reuse
bookkeeping is not a model-facing choice.

Separate host conversations remain separate execution scopes even when they
open the same checkout. A supervisor conversation can use
`execution_scope_list`, `execution_scope_status`, and `execution_scope_audit`
to inspect another scope's bounded operational state—linked workspaces, live
processes, tool outcomes, and normalized error categories—without sharing model
context or reading a transcript. When the target explicitly recorded a recovery
capsule, the list includes a compact mission/frontier-derived display label and
status projects the fuller bounded semantic mission/frontier and safety state.
The label is not the host chat title, and DevSpace never invents semantic fields
from paths or tool events. Scope summaries also expose the elapsed MCP
observation gap while stating that model progress, provider generation, and a
hang determination are unavailable between MCP calls. Cross-scope authority
freshness remains unverified, so reconcile the project's current canonical,
writer, runtime, and effect state before takeover. This does not grant writer
authority; use an isolated worktree for parallel writers.

## Close Work at Real Boundaries

DevSpace does not run a blocking assistant-turn timer. When the host supplies no
exact turn identity, call `turn_horizon_begin` once near the first tool call of
the assistant turn. The fallback horizon emits sparse advisory notices only;
tools remain fully available before and after the estimate.

After the horizon starts, the first explicit file/artifact mutation may append
one adoption notice when the current turn has no recovery capsule. Continue the
current causal chain; record the rolling capsule at the next natural material
transition. The notice does not require an immediate checkpoint or alter task
selection.

Continue normal dynamic work until the current causal slice reaches a coherent
recovery cut. Do not hurry the task, reduce validation, force a commit, or avoid
a justified prerequisite merely because a notice appeared. Record the frontier
with `recovery_capsule_record`; an intentional dirty worktree is valid when its
state, validation ceiling, effect safety, do-not-repeat constraints, and exact
next action are explicit.

At the next turn, open the exact workspace and call
`recovery_capsule_status`. First rehydrate current canonical Git/main,
product-native work and decisions, writer ownership, runtime, and effect state,
then pass their exact immutable refs as `currentAuthorityStateRefs`. The tool
reports local workspace freshness separately from authority freshness. An
unchanged worktree can still be semantically obsolete after another executor
advanced the project. Exact-action reliance remains blocked when authority is
unverified or changed. Time alone does not make a capsule stale or current. See
[Turn Continuity and Recovery Capsules](turn-continuity.md).

## Codex Native Integration and the Legacy AOQ Adapter

The general Codex collaboration surface is the typed native integration:

- `codex_gateway_status`
- `codex_session_list`
- `codex_session_read`
- `codex_session_activity`
- `codex_session_metrics`
- `codex_account_usage`
- `codex_model_list`
- `codex_live_events`
- `codex_approval_list`
- `codex_session_open`
- `codex_turn_control`
- `codex_session_control`
- `codex_approval_respond`
- `codex_effect_status`

It can discover and operate multiple configured App Servers and sessions with
opaque refs. It preserves native Codex thread/turn capabilities and does not
place the Codex executor behind DevSpace. DevSpace is only an edge client for
another peer executor. Current Git, task, writer, publication, runtime, and
business-effect authority remain external and must be reconciled before
overlapping mutation. See [Codex Native Integration](codex-native-integration.md).

The persistent native channel receives real-time events and server-initiated
approval/input requests. It never auto-approves. Private reasoning is excluded,
secret questions cannot be answered through the model-facing route, and an
approval response remains indeterminate until native resolution is observed.

The obsolete single-thread AOQ session adapter has been retired from the MCP
tool surface. Current and multi-session Codex inspection always starts with the
generic gateway rather than a fixed historical thread. Codex gateway health or
one Codex thread lifecycle still does not determine whether DevSpace workspace
execution is healthy.

The `codex_workspace_*` read-only tools inspect the exact allowlisted AOQ
worktree independently from session discovery. They remain a narrow forensic
and transition projection, not a Codex session interface. Product continuation
should hydrate a new executor from canonical state rather than require one App
Server process or provider-private thread to survive.

## Cross-Session Messages

A supervisor scope can send a durable message to another known `scopeRef` with
`execution_scope_message_send`. Reuse the same idempotency key on retries. A
successful send means only that DevSpace stored the message; it does not mean an
inactive WebChat was awakened or that the target observed it.

The target sees a compact pending-mail notice on its next normal MCP tool
result, then calls `execution_scope_message_inbox` to read target-bound content.
Inbox delivery marks the message observed. The target records acknowledged or
acted state with `execution_scope_message_receipt`; the sender can inspect that
state through `execution_scope_message_status`.

A pure `write_stdin` poll wakes immediately for new target-scope mail and
reports `wakeReason=mailbox`. The process continues running and the message
remains unread until the inbox tool is called. See
[Execution-Scope Messaging](execution-scope-messaging.md) for the complete
lifecycle, retention, security, and authority boundaries.

Worktree mode is deliberately different: every call creates a new managed
worktree and a new workspace session with complete context, even for the same
path and base ref.

The first successful open of a checkout provides complete instructions and
coding context. A repeated open that reuses the same checkout workspace does
not repeat the model-visible context, but the workspace UI continues to show the
complete details. Every new worktree establishes and returns its own complete
context, even when the same project was already opened in checkout or another
worktree. Opening checkout after a worktree therefore provides the checkout's
own context.

Do not call `open_workspace` again for the same checkout folder unless:

- the `workspaceId` is rejected as unknown
- work moves to a different project folder
- work switches between checkout and worktree mode
- the user asks for a new isolated worktree

## Checkout Mode

Checkout mode is the default. DevSpace opens the actual directory:

```json
{
  "path": "~/work/my-project"
}
```

Use this when the user wants ChatGPT to work in the current checkout.

## Worktree Mode

Use worktree mode for isolated parallel work:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under:

```text
~/.devspace/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `baseRef` is provided.

Each worktree-mode call creates a new managed worktree and returns a new
`workspaceId`. Reuse that ID for work inside that worktree; call
`open_workspace` in worktree mode again only when another isolated worktree is
actually required.

Uncommitted source checkout changes are not copied into the managed worktree.
DevSpace reports when the source checkout was dirty so the model can decide how
to proceed with the user.

## Project Instructions

When a workspace opens, DevSpace loads root-level instruction files:

- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`

Nested instruction files are returned as `availableAgentsFiles`. The model
should read the relevant nested file before working under that directory.

Nested discovery is intentionally bounded so opening a broad directory does
not make the MCP request depend on its full descendant tree. DevSpace returns
the complete nested inventory only when it contains at most 100 files, uses at
most 16 KiB of relative paths, and completes within two seconds. If any limit
is exceeded, `open_workspace` returns only global and root-level instructions,
marks `instructionDiscovery` as incomplete, and asks the model to open the
specific project directory before working inside it. Partial inventories are
never presented as complete context.

This keeps instructions explicit and inspectable instead of silently injecting
new context during later tool calls.

## Skills

Skills are enabled by default for coding-agent workflows.

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from `~/.devspace/agents/*.md` and project `.devspace/agents/*.md`.
`open_workspace` exposes a compact catalog with profile names, descriptions,
providers, and optional models/thinking levels so the model can choose a configured agent
without seeing provider-specific launch details.

Example profiles are packaged under `examples/agents/` for users who want
starter templates. Copy or adapt them into one of the active profile directories
before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

`open_workspace` advertises project-local, bundled, explicitly configured, and
workspace-contextual skills. Host-global niche skills are kept out of the
default context and remain discoverable with `skill_search`. Use that tool only
when the task needs a specialized procedure that was not listed automatically.

When either tool returns a matching skill, the model should read the advertised
`SKILL.md` before following it. Search returns metadata only; it does not inject
the skill body.

Skill paths may be outside the workspace. DevSpace only permits reading:

- `SKILL.md` files advertised by `open_workspace` or `skill_search`
- files under a skill directory after that skill's `SKILL.md` has been read

Host-global skills default to on-demand. Project-local and explicitly
configured skills default to automatic exposure. A skill can opt into
workspace-contextual exposure with `x-devspace.workspace-markers` frontmatter;
all markers must exist relative to the workspace.

Set `DEVSPACE_SKILLS=0` to hide skills from workspace output. Set
`DEVSPACE_SUBAGENTS=1` to expose the experimental subagent catalog and
`subagent-delegation` skill. When local-agent MCP tools are visible, use
`local_agent_session_list`, `local_agent_message_send`, and
`local_agent_turn_status` so follow-ups enter the durable serialized queue.
Use `local_agent_turn_cancel` for cancellation and reserve
`local_agent_turn_resolve` for evidence-backed reconciliation of an
indeterminate turn. An ordinary provider failure pauses later queued work; use
`local_agent_session_resume` after inspecting it. The CLI exposes the same state
machine through `devspace agents ls`, `run`, `show`, `turn`, `cancel`, `resume`,
and `resolve`.

Codex, Claude, OpenCode, and Pi follow-ups resume the committed provider session
ID from the preceding successful turn. Cursor and Copilot do not advertise
qualified continuation in this version; DevSpace fails explicitly rather than
starting an unrelated provider session. See
[Local-Agent Session Continuation](local-agent-continuation.md).

## Tool Names

DevSpace exposes these tool names:

- `open_workspace`
- `skill_search` when skills are enabled
- `read`
- `write`
- `edit`
- `bash`

When turn continuity is enabled, every tool mode also exposes:

- `turn_horizon_begin`
- `turn_horizon_status`
- `recovery_capsule_record`
- `recovery_capsule_status`

Execution-scope observability and messaging tools remain available according to
their own feature flags.

By default, DevSpace also runs in `DEVSPACE_TOOL_MODE=minimal`, so dedicated
`grep`, `glob`, and `ls` tools are hidden. Use `bash` with command-line tools
such as `rg`, `find`, and `ls` for search and directory inspection.

Use `DEVSPACE_TOOL_MODE=full` to restore dedicated search and directory tools.

The experimental Codex-style surface is enabled with
`DEVSPACE_TOOL_MODE=codex`. It exposes:

- `open_workspace`
- `skill_search` when skills are enabled
- `read`
- `apply_patch`
- `exec_command`
- `write_stdin`

In this mode, `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are not
registered. `exec_command` returns a process session ID when a command is still
running after its yield window. Use `write_stdin` to poll it, send input, resize
a PTY, or send Ctrl-C. Set `tty: true` only for commands that need a terminal.
A pure poll may also return early for pending execution-scope mail without
interrupting the process.

## Show Changes

By default, `DEVSPACE_WIDGETS=full`.

In that mode, DevSpace attaches widget UI to the exposed workspace, file, edit,
and shell tools. The aggregate `show_changes` tool is not exposed by default.

Use `DEVSPACE_WIDGETS=off` to disable widget UI, or `DEVSPACE_WIDGETS=changes`
to expose the aggregate show-changes flow.

When `show_changes` is exposed, call it exactly once after the final file
modification in any turn that changes files. It shows the combined changes for
that turn and advances the review point automatically. Reusing a workspace does
not change this workflow.

## Shell Use

The shell tool is for commands that belong in a terminal:

- tests
- builds
- git inspection
- package scripts
- environment checks

File writes should go through the edit/write tools rather than shell
redirection, heredocs, `tee`, `sed -i`, or generated scripts.

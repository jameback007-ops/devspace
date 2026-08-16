# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |

## Executor Turn Window

The executor window is an optional interruption-safety guard for MCP hosts whose
model turns may end at an unknown platform cutoff. It does **not** divide or time
limit the underlying task. A task may continue across any number of turns.

```bash
DEVSPACE_EXECUTOR_WINDOW=1 \
DEVSPACE_EXECUTOR_WINDOW_DRAIN_MINUTES=90 \
DEVSPACE_EXECUTOR_WINDOW_YIELD_MINUTES=100 \
npx @waishnav/devspace serve
```

Conversation identity and assistant-turn identity are separate. A host that can
identify one assistant turn should send the same `devspace/executor-turn`
metadata value on every tool call in that turn and a different value in the
next turn. Only those exact host-bound windows may enforce a hard landing.

When a host does not expose turn identity, call
`executor_window_begin(reason=new_turn)` exactly once as the first tool call of
every assistant turn. That explicit call resets the clock even if the previous
conversation window remains active or draining. Because DevSpace cannot prove
where the host ended a turn, explicit and automatic fallback windows remain
advisory: after the drain threshold they warn and roll into a fresh advisory
window instead of blocking a later turn. Conversation age is never treated as
turn age.

Normal tool results include a compact window status. For an exact host-bound
window, the model should finish its current local causal chain at DRAIN, persist
a recoverable checkpoint or handoff, and avoid opening a new major frontier. At
YIELD_REQUIRED, DevSpace blocks new mutation and command execution while still
allowing read/reconciliation tools, bounded mailbox send/inbox/receipt
operations, and polling or interrupting an existing process.
`executor_window_yield` records a
bounded advisory handoff before the assistant turn ends.

The window is runtime scheduling metadata only. It is not task, checkpoint,
memory, release, writer, or effect authority. The advisory handoff does not
replace Git, a canonical database, runtime/effect readback, or a product-native
continuation contract.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_EXECUTOR_WINDOW` | `0` | Enable the executor-turn guard. |
| `DEVSPACE_EXECUTOR_WINDOW_DRAIN_MINUTES` | `90` | Enter DRAIN and stop opening major new work. |
| `DEVSPACE_EXECUTOR_WINDOW_YIELD_MINUTES` | `100` | Require a safe yield and block new mutation/commands. Must exceed DRAIN. |
| `DEVSPACE_EXECUTOR_WINDOW_RETENTION_HOURS` | `24` | Retain in-memory yielded handoff state for later turns while the server remains running. |

## Execution-Scope Observability

DevSpace keeps independent host conversations in separate provider-neutral
execution scopes. The read-only `execution_scope_list`,
`execution_scope_status`, and `execution_scope_audit` tools allow one scope to
inspect another scope's operational state without sharing model context or
capturing a transcript. See
[Execution-Scope Observability](execution-scope-observability.md) for the data
and authority boundaries.

The metadata-only audit is enabled by default. It persists tool lifecycle,
workspace links, process state, digests, timing, and normalized error categories
in the existing owner-only SQLite database. It never stores arbitrary exception
messages, prompts, private reasoning, tool output, raw commands, patch bodies,
credentials, or native file handles.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_EXECUTION_OBSERVABILITY` | `1` | Enable durable execution-scope status and audit. |
| `DEVSPACE_EXECUTION_OBSERVABILITY_RETENTION_HOURS` | `168` | Retain audit events for seven days. Maximum 90 days. |
| `DEVSPACE_EXECUTION_OBSERVABILITY_MAX_EVENTS_PER_SCOPE` | `1000` | Maximum retained events per execution scope. |
| `DEVSPACE_EXECUTION_OBSERVABILITY_IDLE_MINUTES` | `5` | Classify a non-running scope as idle after this interval. |

## Execution-Scope Messaging

The execution mailbox is enabled by default. It provides durable target-bound
messages and monotonic observed, acknowledged, and acted receipts between known
execution scopes. See
[Execution-Scope Messaging](execution-scope-messaging.md) for delivery,
security, and authority semantics.

Messages reach WebChat at the target's next MCP boundary. A pure `write_stdin`
poll also wakes immediately when new target-scope mail arrives; the process is
not interrupted, and the message remains unread until the target calls
`execution_scope_message_inbox`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_EXECUTION_MAILBOX` | `1` | Register durable execution-scope messaging tools and pending notices. |
| `DEVSPACE_EXECUTION_MAILBOX_DEFAULT_TTL_HOURS` | `168` | Default seven-day message lifetime. |
| `DEVSPACE_EXECUTION_MAILBOX_MAX_TTL_HOURS` | `720` | Maximum caller-selected lifetime. |
| `DEVSPACE_EXECUTION_MAILBOX_TERMINAL_RETENTION_HOURS` | `168` | Retain acted or expired messages and receipts for later status review. |
| `DEVSPACE_EXECUTION_MAILBOX_MAX_PENDING_PER_SCOPE` | `500` | Bound live unacted messages for one target scope. |
| `DEVSPACE_EXECUTION_MAILBOX_MAX_BODY_CHARACTERS` | `12000` | Maximum persisted body length for one message. |

## Native Artifact Download

Native-file download is disabled by default. Enable it when ChatGPT needs to hand
an attached or generated file into an already-open workspace:

```bash
DEVSPACE_ARTIFACTS=1 npx @waishnav/devspace serve
```

This feature currently supports Linux. It is not registered on macOS, Windows,
or BSD because the secure publication path depends on traversable,
descriptor-anchored directory paths provided by Linux procfs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_ARTIFACTS` | `0` | Expose `download_artifact` for trusted native files. |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `104857600` | Maximum streamed size of one file (100 MiB). |

The same settings may be persisted in `~/.devspace/config.json` as
`artifactsEnabled` and `artifactMaxFileBytes`.

`download_artifact` accepts the native file object supplied by the MCP connector,
a `workspaceId` returned by `open_workspace`, and a relative workspace `path`.
DevSpace safely creates missing parent directories, refuses to overwrite an
existing destination, and returns only the normalized workspace-relative path.
It does not accept conflict modes, expected hashes, arbitrary URL strings, local
paths, embedded credentials, or extra object fields.

There is no artifact root, total quota, TTL, pinning, persistent database record,
or background artifact cleanup service. See [Native File Download](artifact-exchange.md)
for the supported connector shape and security boundaries.

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Tool Modes

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, and `bash`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Experimental. Exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, and `write_stdin`. Existing mutation and shell tools are hidden. |

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `DEVSPACE_TOOL_MODE` and always uses
its fixed short tool names regardless of `DEVSPACE_TOOL_NAMING`.

Codex-mode commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions. A pure `write_stdin` poll waits for new output, process completion, or
new target-scope mailbox activity and returns immediately when any occurs. Its
default ceiling is 90 seconds and its maximum is 110 seconds. Calls that send
input or resize a PTY retain the short interactive wait and 30-second maximum.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_SUBAGENTS` | Set to `1` to expose configured agent profiles as Subagents. Experimental and disabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/thinking levels so the host model can choose an
agent without reading provider-specific launch details. `devspace agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagent-delegation`
skill teaches the model to use only the minimal `devspace agents ls`,
`devspace agents run`, and `devspace agents show` workflow.

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @waishnav/devspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_ARTIFACTS="1" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.

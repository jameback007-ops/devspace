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
| `DEVSPACE_COMMAND_ENV_PASSTHROUGH` | Comma- or whitespace-separated names of additional service environment variables that command processes may inherit. The control variable itself is never inherited. |

## Command Environment Boundary

Workspace commands do not inherit the DevSpace server's complete environment.
They receive a bounded operating environment (`PATH`, identity/home, locale,
temporary-directory, certificate, and platform variables), deterministic
terminal settings, and the current workspace/execution-scope identifiers.
Server credentials such as the OAuth owner token, provider keys, tunnel
credentials, deployment attestations, and unrelated service variables are not
passed to arbitrary commands.

When a toolchain needs another service-level variable, name it explicitly in
`DEVSPACE_COMMAND_ENV_PASSTHROUGH`. Values remain in the service environment;
the configuration contains names only. Invalid names fail closed, duplicates
are ignored, and `DEVSPACE_COMMAND_ENV_PASSTHROUGH` cannot pass itself.
`EXA_API_KEY` and `CONTEXT7_API_KEY` are reserved fixed-service credentials and
are rejected even when an operator accidentally names them here; only the typed
research provider broker may copy those handles into its exact child process.

```bash
DEVSPACE_COMMAND_ENV_PASSTHROUGH="UV_CACHE_DIR PANTS_LOCAL_STORE_DIR PANTS_NAMED_CACHES_DIR PANTS_PANTSD PANTS_WATCH_FILESYSTEM"
```

This boundary reduces accidental credential propagation. It is not a shell
sandbox: commands still run with the configured operating-system identity.

## Optional Nexus Primary Recovery Controller

The primary-recovery controller is a separate host process, not a DevSpace MCP
tool and not part of the primary server process. It probes the fixed loopback
`/readyz` endpoint, holds one recovery-owner lease, persists sanitized incident
receipts, and may restart only `devspace-zesnexus.service` after a bounded
failure threshold and restart-safety check. Repair effects are disabled by
default.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZES_NEXUS_PRIMARY_RECOVERY_EFFECTS` | `0` | Enables the fixed Nexus service restart effect only after an observation-only canary. |
| `ZES_NEXUS_PRIMARY_READY_URL` | `http://127.0.0.1:7677/readyz` | Fixed loopback functional-readiness route. Non-loopback and non-HTTP targets are rejected. |
| `ZES_NEXUS_PRIMARY_HOST_HEADER` | `mcp.zesnexus.com` | Host header for the local readiness request. |
| `ZES_NEXUS_PRIMARY_RECOVERY_STATE_ROOT` | `/run/devspace-zesnexus-primary-recovery` | Volatile lease and incident-state directory. |
| `ZES_NEXUS_PRIMARY_RECOVERY_RECEIPT_ROOT` | `/var/lib/devspace-zesnexus/incident-snapshots/primary-recovery` | Durable sanitized recovery receipts. |
| `ZES_NEXUS_PRIMARY_RECOVERY_FAILURE_THRESHOLD` | `3` | Consecutive failed readiness probes required before a repair is considered. |
| `ZES_NEXUS_PRIMARY_RECOVERY_MAX_REPAIR_ATTEMPTS` | `1` | Maximum automatic service repairs per incident before diagnostic escalation. |
| `ZES_NEXUS_PRIMARY_RECOVERY_PROBE_TIMEOUT_MS` | `5000` | Readiness request timeout. |
| `ZES_NEXUS_PRIMARY_RECOVERY_STABLE_PROBE_COUNT` | `3` | Consecutive healthy post-repair probes required for failback. |
| `ZES_NEXUS_PRIMARY_RECOVERY_STABLE_PROBE_MAXIMUM` | `6` | Maximum post-repair probes before the repair is considered unverified. |
| `ZES_NEXUS_PRIMARY_RECOVERY_STABLE_PROBE_DELAY_MS` | `2000` | Delay between post-repair probes. |
| `ZES_NEXUS_PRIMARY_RECOVERY_LEASE_STALE_AFTER_MS` | `300000` | Minimum age before a lease held by a dead process may be reclaimed. |

Install the example service and timer from `examples/systemd/` only after the
deployed release exposes `/readyz`. Keep effects off first. Before enabling the
effects drop-in, disable the old health-only restart timer so one incident has
exactly one restart owner. The controller never deploys or rolls back a release,
opens or deletes the live SQLite database, mutates Legacy, or replays an MCP
effect. The example unit overrides the receipt root with its own systemd-managed
`StateDirectory`, while the table above documents the standalone-controller
default. See [MCP Primary-First Self-Healing](mcp-primary-self-healing.md).

## Optional ZES Research Reflex Lifecycle

DevSpace can bind material work in a ZES checkout to the native ZES Research
Reflex v3 admission and episode contracts. The feature is disabled by default
and activates only for opened workspaces containing
`packages/zes-control-kernel/pyproject.toml`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_ZES_RESEARCH_CYCLE_MODE` | `off` | `off`, advisory `observe`, or fail-closed `enforce`. |
| `DEVSPACE_ZES_RESEARCH_REPOSITORY_ROOT` | `/srv/zes-codex/ZES-SYSTEM-BLUEPRINT` | Fixed repository providing the native `zes-research-reflex` application port. `DEVSPACE_ZES_REPOSITORY_ROOT` is accepted as a compatibility fallback. |
| `DEVSPACE_ZES_RESEARCH_STATE_ROOT` | `<DEVSPACE_STATE_DIR>/zes-research-cycles` | Owner-local lifecycle, receipt, and evidence state. |
| `DEVSPACE_ZES_RESEARCH_TIMEOUT_SECONDS` | `60` | Native Research Reflex command timeout; maximum 300 seconds. |
| `DEVSPACE_ZES_RESEARCH_TRUSTED_TRACE_ROOTS` | empty | Comma-separated additional roots for exact provider trace receipts. |
| `EXA_API_KEY` | empty | Optional service-held Exa handle required by the fixed `zes_research_provider_invoke` Exa route. Exa `search` is the open-world operation; Exa `fetch` remains known-source acquisition. The handle is copied only into that exact child process and never into arbitrary `exec_command` or model-visible output. |
| `CONTEXT7_API_KEY` | empty | Optional service-held Context7 handle for the fixed provider broker. Anonymous Context7 remains usable when supported upstream. |

`observe` reports guard findings but allows the operation, while recording
scope, dependency, failure, and lifecycle drift for reassessment. `enforce`
holds ZES source mutation, commit preparation, commit, and publication unless
the exact current native receipt, action scope, lease, pre-commit checkpoint,
commit, and closure state permit the requested operation. Runtime effects are
never authorized by research admission. Shell source/dependency mutation must
also match an exact command supplied during `zes_research_cycle_prepare`; raw
commands are not persisted, only their SHA-256 digests.

The adapter is executor-local and does not grant task, semantic, writer,
publication, release, activation, runtime, or effect authority. See
[ZES Research Reflex Execution Cycle](research-execution-cycle.md) for the tool
flow, native bindings, and failure semantics.

## Workspace Lifecycle and Worktree Garbage Collection

DevSpace persists checkout and managed-worktree sessions. Use
`workspace_list`, `workspace_status`, and `workspace_candidate_inventory` to
inspect them. Every new managed worktree is created on the executor-owned local
branch `devspace/workspaces/<workspaceId>` instead of detached HEAD. Inventory
classifies dirty recovery, missing validation, publication readiness,
reconciliation, integration, and terminal cleanup separately from operational
activity. It also exposes bounded mission/frontier/next-action hints and linked
scope refs from explicit recovery capsules; task meaning is never inferred from
filenames or tool events.

`workspace_close` unregisters a checkout or safely removes a managed worktree.
It refuses removal while a DevSpace or operating-system process references the
worktree or while uncommitted changes exist. `force=true` never authorizes
discarding dirty state. It may remove a clean committed worktree while retaining
its preservation ref as a branch-only publication candidate. Older detached
workspaces receive an exact-HEAD preservation ref before such a close.

Worktree garbage collection is a two-step contract:

1. `workspace_gc_preview` classifies every directory under
   `DEVSPACE_WORKTREE_ROOT` and returns a SHA-256 plan ID.
2. `workspace_gc_execute` accepts that exact plan ID and the same options,
   recomputes the plan, then revalidates each candidate immediately before
   removal.

The collector protects workspaces loaded in the current server, recent
workspace/scope activity, running processes, dirty or unreadable Git state,
commits not reachable from a branch/tag/remote ref, unresolved publication debt,
and recent or explicitly active recovery capsules. Candidate validation is
current only when a passed capsule contains evidence refs and its Git fingerprint
matches the exact current HEAD and dirty state. GC recomputes a stable lifecycle
digest immediately before each removal and deletes executor-owned preservation
refs with an expected-HEAD compare-and-swap only after terminal integration.
Defaults are 24 hours for recent activity and 72 hours for capsule protection.
Measuring directory sizes is optional because it can make preview slower on
large repositories.

See [Workspace Candidate Lifecycle](workspace-candidate-lifecycle.md) for the
state machine and authority boundaries.

### Fixed DevSpace self-repository publication

DevSpace can optionally expose a fixed publication preflight for its own source
repository. The model supplies only a registered workspace ID. Repository root,
remote, branch, expected remote URL, refspec construction, and expected-old
authority are server-owned. Preflight reads fresh remote authority with
`git ls-remote`, binds validation to the exact clean candidate HEAD, and requires
zero-behind/no-merge history. Effects are a separate opt-in and use an exact
candidate-object refspec, `--force-with-lease`, and post-effect remote readback.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_SELF_REPOSITORY_PUBLICATION` | `0` | Enable the fixed read/preflight contract. |
| `DEVSPACE_SELF_REPOSITORY_ROOT` | unset | Exact absolute DevSpace source repository root. Required when enabled. |
| `DEVSPACE_SELF_REPOSITORY_REMOTE` | `owner` | Fixed local remote name. |
| `DEVSPACE_SELF_REPOSITORY_BRANCH` | `main` | Fixed remote authority branch. |
| `DEVSPACE_SELF_REPOSITORY_EXPECTED_REMOTE_URL` | unset | Exact configured remote URL identity. Required when enabled. |
| `DEVSPACE_SELF_REPOSITORY_PUBLICATION_EFFECTS` | `0` | Register the digest-bound publication effect. Requires the preflight contract. |

## Advisory Turn Continuity and Recovery Capsules

DevSpace provides a soft assistant-turn horizon, instability-aware early
landing, a persisted bounded machine operational envelope, and Git-bound
semantic recovery capsules. This replaces the retired executor-window
mechanism without restoring its blocking behavior. Nothing in this layer
disables tools, requires task completion, forces a commit, suppresses dynamic
replanning, retries an effect, or authorizes weaker validation.

When a host supplies `devspace/executor-turn`, DevSpace begins a fresh advisory
epoch for that exact assistant turn. A host may also supply an exact absolute
deadline through `devspace/executor-deadline-ms` or
`devspace/executor-deadline-at`. When neither is available, the first
non-control tool starts an implicit epoch automatically. `turn_horizon_begin`
remains available for an explicit or recovered boundary with a unique
idempotency key. Conversation age is never substituted for turn age.

The fallback estimate defaults to 120 minutes. At 90 minutes DevSpace emits one
checkpoint-awareness notice, at 100 minutes one landing-opportunity notice,
and at 108 minutes one urgent-landing notice. An exact host deadline uses the
same default lead margins (30, 20, and 12 minutes). All are advisory: finish the
current coherent causal slice at a genuinely recoverable cut, then end only the
assistant turn. A task may continue across any number of turns.

Within a bounded recent window, sanitized lifecycle receipts also classify
`normal`, `degraded`, `unstable`, or `critical` recovery risk. Tool error,
blocked/interrupted lifecycle, repeated normalized failures, backend epoch
change, stale ordinary tool observation, capsule debt, running process
exposure, and explicit in-flight/unknown effect state are considered. A normal
nonzero command exit and a legitimate long `exec_command`/`write_stdin` are not
misclassified as transport failure. The result is guidance only and does not
grant mutation, writer, effect, or publication authority.

When timing or instability becomes material, DevSpace persists a bounded
machine operational envelope per scope/epoch. It contains opaque IDs, event and
checkpoint timing, safe running process/tool metadata, backend identity,
sanitized risk counts, and explicit capsule/effect disposition. It excludes
prompts, transcripts, private reasoning, tool output, exception messages, raw
commands, patches, credentials, arbitrary paths, and inferred mission. A
`turn_boundary` capsule seals the current epoch; the next non-control tool
starts a fresh epoch while resume guidance preserves the same explicit mission.

`recovery_capsule_record` stores bounded semantic recovery state together with a
digest of the exact Git HEAD, branch, tracked diff, status, and bounded
untracked content. Intentional dirty state is valid. Record exact immutable
authority-state refs from current canonical/runtime/writer/effect owner
readback when available. `recovery_capsule_status` recomputes local workspace
freshness separately from authority freshness; pass freshly rehydrated
`currentAuthorityStateRefs` for comparison. A locally unchanged worktree never
proves that another executor did not advance canonical Git/main, PostgreSQL,
runtime, writer, or effect state. Capsules are executor-local recovery
projections, not task, decision, writer, effect, publication, or
canonical-memory authority. Time or TTL alone does not determine semantic
validity.

Legacy `DEVSPACE_EXECUTOR_WINDOW*` variables remain ignored. The current
configuration is:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_TURN_CONTINUITY` | `1` | Enable advisory horizon and recovery capsule tools. |
| `DEVSPACE_TURN_HORIZON_MINUTES` | `120` | Fallback estimated host turn duration. |
| `DEVSPACE_TURN_HORIZON_AWARENESS_MINUTES` | `90` | Emit one early checkpoint-awareness notice. |
| `DEVSPACE_TURN_HORIZON_LANDING_MINUTES` | `100` | Emit one nearest-recoverable-cut notice. |
| `DEVSPACE_TURN_HORIZON_URGENT_MINUTES` | `108` | Emit one urgent nearest-safe-cut notice. Must be below the estimated horizon. |
| `DEVSPACE_TURN_INSTABILITY_WINDOW_MINUTES` | `15` | Bounded lifecycle evidence window used for instability assessment. |
| `DEVSPACE_TURN_CAPSULE_REFRESH_MINUTES` | `30` | Mark an active capsule as carrying refresh debt after later activity or mutation. |
| `DEVSPACE_TURN_STALE_TOOL_MINUTES` | `5` | Stale threshold for a running ordinary non-process tool observation. Long process tools are exempt. |
| `DEVSPACE_TURN_STALE_PROCESS_MINUTES` | `20` | Stale-output exposure threshold for a running process; exposure alone does not prove failure. |
| `DEVSPACE_RECOVERY_CAPSULE_RETENTION_HOURS` | `720` | Retain capsules for 30 days. |
| `DEVSPACE_RECOVERY_CAPSULE_MAX_PER_WORKSPACE` | `50` | Bound retained capsules per exact workspace root. |
| `DEVSPACE_RECOVERY_CAPSULE_MAX_CHARACTERS` | `64000` | Bound one capsule's semantic payload. |

See [Turn Continuity and Recovery Capsules](turn-continuity.md) for the complete
behavior and authority boundaries.

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

Set `DEVSPACE_CODEX_NAVIGATION_TOOLS=1` to add the upstream-native read-only
`grep`, `glob`, and `ls` handlers to `codex` mode. This composes the dedicated
workspace-bounded navigation tools with `apply_patch`, `exec_command`, and
`write_stdin`; it does not add another shell, patch, workspace, or process
engine. The option is disabled by default so existing MCP tool surfaces remain
stable.

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

Discovery and automatic exposure are separate. `open_workspace` advertises:

- project-local skills under the opened workspace;
- bundled feature skills such as `subagent-delegation` when enabled;
- skills from explicit `DEVSPACE_SKILL_PATHS`;
- host-global skills whose optional `x-devspace` metadata selects `auto` or
  whose `contextual` workspace markers all exist.

Other host-global skills remain in the metadata-only catalog and are available
through `skill_search`. This keeps niche VPS or provider procedures out of every
workspace context without making them undiscoverable. A search result authorizes
reading that exact `SKILL.md`; DevSpace does not load the file automatically.

Optional frontmatter extension:

```yaml
x-devspace:
  exposure: contextual # auto | contextual | on-demand
  workspace-markers:
    - package.json
    - src/server.ts
```

Markers are workspace-relative and all must exist. A skill with markers and no
explicit exposure is treated as contextual. Host-global skills with no
extension default to on-demand; project-local and explicitly configured skills
default to auto.

When Subagents are enabled, DevSpace discovers agent profiles
from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/thinking levels so the host model can choose an
agent without reading provider-specific launch details. `devspace agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagent-delegation`
skill teaches the model to enqueue work, inspect the durable turn, and cancel or
reconcile it when necessary instead of launching overlapping provider workers.

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

## Workspace System Indexes

`DEVSPACE_WORKSPACE_SYSTEM_INDEX_PATHS` accepts a comma-separated list of
absolute or home-relative generated JSON manifests. Each manifest declares
bounded workspace marker sets plus a compact system stack, engineering
capability routing map, source identities, and authority notes. When an opened
checkout or managed worktree matches a marker set, `open_workspace` injects the
index into both its model-readable text and structured `systemIndexes` output.

The manifest's `sourceIdentity.rootRelativeToManifest` must identify an
ancestor one to four levels above the manifest, and every listed source path
must be a regular relative file below that root with an exact byte count and
SHA-256. DevSpace verifies the source identity when loading the configured
manifest and again before projecting it into a matching workspace. A source
change without deterministic regeneration therefore fails closed instead of
silently hydrating stale stack or capability guidance.

This layer is for mandatory orientation that must not depend on a model
eventually finding another repository's `AGENTS.md`. It is not current task,
writer, runtime, release, memory, or effect authority. Entries should point to
the rightful source for detailed or current state, and large procedures remain
on-demand skills.

Configured manifests are loaded and strictly validated when the
`WorkspaceRegistry` starts. Missing, malformed, oversized, duplicate-ID, or
unsafe-marker manifests, stale source identities, source symlinks, or source
paths escaping the named authority root fail closed instead of silently
omitting or corrupting mandatory context. A matching index is returned once per
conversation bootstrap, like root instructions and automatically exposed
skills; repeated opens in the same conversation reuse the already supplied
context.

The user config file may set the equivalent array:

```json
{
  "workspaceSystemIndexPaths": [
    "/srv/zes-codex/ZES-SYSTEM-BLUEPRINT/release/workspace-system-index.json"
  ]
}
```

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @waishnav/devspace serve
```

## Local-Agent Continuation

When `DEVSPACE_SUBAGENTS=1`, CLI and MCP-originated prompts share one durable
per-agent queue and worker lease. Codex, Claude, OpenCode, and Pi follow-up turns
resume the provider session committed by the preceding successful turn. Cursor
and Copilot remain initial-invocation adapters in this version; DevSpace does
not silently claim continuation for an existing ACP session.

See [Local-Agent Session Continuation](local-agent-continuation.md) for queue,
lease, cancellation, crash-recovery, and authority semantics.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_LOCAL_AGENT_MAX_PENDING` | `200` | Bound queued, active, and indeterminate turns for one agent session. |
| `DEVSPACE_LOCAL_AGENT_MAX_BODY_CHARACTERS` | `24000` | Maximum persisted prompt body for one local-agent turn. |
| `DEVSPACE_LOCAL_AGENT_MAX_RESPONSE_CHARACTERS` | `200000` | Maximum persisted final provider response for one turn. |
| `DEVSPACE_LOCAL_AGENT_LEASE_SECONDS` | `120` | Worker lease duration. A new worker may recover only after expiry. |
| `DEVSPACE_LOCAL_AGENT_HEARTBEAT_SECONDS` | `15` | Lease renewal and running-cancellation poll interval. Must be less than the lease duration. |
| `DEVSPACE_LOCAL_AGENT_TERMINAL_RETENTION_HOURS` | `168` | Retain succeeded, failed, and cancelled turns for seven days. |
| `DEVSPACE_LOCAL_AGENT_BILLING_MODE` | `subscription_only` | Reject known API/BYOK routes and ambiguous auth. Set `payg_allowed` only to opt into usage-billed credentials. |

`subscription_only` is deliberately fail-closed. Codex must attest a ChatGPT
login and Claude must attest first-party subscription auth. Cursor and Copilot
remain available only when their known API/BYOK environment overrides are not
present. OpenCode and Pi are unavailable in this mode because the current
DevSpace adapters do not pin them to one subscription-backed model provider.
This guard prevents DevSpace from silently choosing a known PAYG route; it is
not a spending cap on vendor-side subscription overage or extra usage.

The MCP surface adds `local_agent_session_list`,
`local_agent_session_status`, `local_agent_session_resume`, `local_agent_message_send`,
`local_agent_turn_status`, `local_agent_turn_cancel`, and
`local_agent_turn_resolve`. The CLI uses the same queue through `devspace agents
run`, `show`, `turn`, `cancel`, `resume`, and `resolve`.

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

## Tool-Surface Deployment Attestation

Qualified ZES Nexus deployments can bind the running source, build artifact,
complete MCP descriptor surface, accelerator profile, and exact native MCP
receipts to a digest-pinned manifest. These variables are optional for ordinary
DevSpace use; when a deployment claims freshness, set the applicable values as
one release unit.

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_MCP_SERVER_VERSION` | Release identity returned in MCP `serverInfo`. Change it for a newly qualified deployed surface. |
| `DEVSPACE_TOOL_SURFACE_MANIFEST` | Absolute path to the validated deployment manifest. |
| `DEVSPACE_TOOL_SURFACE_MANIFEST_SHA256` | Lowercase SHA-256 pin for the complete manifest bytes. |
| `DEVSPACE_TOOL_SURFACE_SOURCE_COMMIT` | Exact source commit loaded into the deployment. |
| `DEVSPACE_TOOL_SURFACE_SOURCE_TREE` | Exact source tree for that commit. |
| `DEVSPACE_TOOL_SURFACE_BUILD_ARTIFACT` | Built server file or complete build directory deterministically hashed by the running process. |
| `DEVSPACE_TOOL_SURFACE_EPOCH` | Deployment epoch expected by the manifest and response headers. |
| `DEVSPACE_ACCELERATOR_PROFILE` | Exact governed accelerator-profile file observed at runtime. |
| `DEVSPACE_ACCELERATOR_PROFILE_REF` | Stable provenance reference recorded alongside the profile digest. |
| `DEVSPACE_NATIVE_MCP_RUNTIME_IDENTITIES` | Optional JSON array of exact native MCP runtime observations; never infer these from names alone. |

See [Tool-Surface Freshness and Deployment Attestation](tool-surface-freshness.md)
for the status model, probe/generator commands, client-attestation boundary,
and restart procedure.

---
name: subagent-delegation
description: Delegate coding tasks to user-configured DevSpace subagents.
---

# Subagent Delegation

Use this skill when the user explicitly asks to delegate work to another coding
agent, use a named subagent, get a second opinion, compare approaches, or run
a subagent-like workflow.

Do not use subagents silently. Tell the user when another subagent is
being used.

## Preferred MCP tools

When the local-agent tools are visible, use:

```text
local_agent_session_list
local_agent_session_status
local_agent_session_resume
local_agent_message_send
local_agent_turn_status
local_agent_turn_cancel
```

`local_agent_message_send` queues one durable turn for an existing Codex,
Claude, OpenCode, or Pi session. Reuse the exact idempotency key only when
retrying the same payload. Acceptance means queued, not completed. Inspect the
returned turn with `local_agent_turn_status`.

One worker lease serializes provider turns. Do not bypass it by launching a
provider CLI directly. `supersedePending` may cancel older queued turns, but it
never replaces running work.

Use `local_agent_turn_resolve` only for an `indeterminate` turn and only after
checking Git, runtime, or effect evidence. Retrying may duplicate an unknown
provider effect.

## CLI fallback

When the MCP tools are not visible, use the CLI backed by the same durable
queue:

```bash
devspace agents ls
devspace agents run <profile-or-provider-or-id> "<prompt>"
devspace agents show <id>
devspace agents turn <turn-id>
devspace agents cancel <turn-id> [note]
devspace agents resume <agent-id> [note]
```

`ls` shows existing subagent sessions for the current workspace. DevSpace scopes
it automatically from the shell environment injected by the workspace tool.

`run <profile> "<prompt>"` starts a new configured profile and prints a
DevSpace agent id.

`run <provider> "<prompt>"` starts a raw built-in provider when no configured
profile is needed. Built-in providers are listed by `open_workspace`.

`run <id> "<prompt>"` enqueues a serialized follow-up to an existing supported
provider session and prints a durable turn ID.

For a retry after an uncertain CLI disconnect, reuse an exact key:

```bash
devspace agents run <id> --idempotency-key <stable-key> "<same prompt>"
```

Use `--supersede-pending` only to cancel older queued turns. It cannot supersede
running or indeterminate work.

`show <id>` prints status and the latest response. If the agent is still
running, `show` waits briefly. If there is still no final response, call `show`
again later.

`turn <turn-id>` shows one queued or terminal provider turn. `cancel` removes a
queued turn immediately or requests best-effort native cancellation of a
running turn. The turn is not cancelled until the provider actually stops.

An ordinary provider failure pauses later queued turns. Inspect the failure,
then use `local_agent_session_resume` or `devspace agents resume <agent-id>` to
authorize one new worker. Do not use resume to bypass an indeterminate turn.

For an indeterminate turn, use the Owner-facing CLI only after evidence review:

```bash
devspace agents resolve <turn-id> <retry|cancelled|succeeded> "<evidence note>"
```

Do not run provider CLIs such as `codex`, `claude`, `opencode`, `pi`,
`cursor-agent`, or `copilot` directly unless you are explicitly debugging
DevSpace agent integration.

Cursor and Copilot may be used for an initial invocation, but DevSpace does not
claim durable continuation for their existing ACP sessions in this version.
Do not imply that a follow-up resumed them when the adapter rejects it.

## Choosing a profile

Choose profiles from the compact subagent profile catalog returned by
`open_workspace`. Use the profile name with `devspace agents run`. If no
profile fits and delegation is still appropriate, use a built-in provider name
from `open_workspace`.

Profiles may declare a model and optional thinking level. To override the
configured/default provider model or thinking level for a run, pass `--model`
or `--thinking`:

```bash
devspace agents run <profile-or-provider> --model <model> "<prompt>"
devspace agents run <profile-or-provider> --thinking <level> "<prompt>"
```

Use `--thinking` only when the user asks for a specific reasoning depth or when
the task clearly needs a different effort than the configured profile default.
Thinking values are provider-specific passthrough values. Use names supported by
the selected local agent harness; DevSpace does not translate values between
providers.

Good delegation targets:

- `reviewer`: second opinion, bug risk, security risk, test gaps.
- `explorer`: read-only codebase investigation.
- `implementer`: focused implementation when the user asked for delegation.

Do not delegate ordinary coding work just because a profile exists. Use normal
DevSpace tools unless the user asked for delegation, another agent's opinion,
parallel work, or a named subagent.

## Worker prompts

Agents start with only the prompt you send plus their configured profile
instructions. Make prompts self-contained.

Implementation prompt shape:

```text
Goal:
<clear goal>

Context:
<repo/module/user constraints>

Relevant files:
<paths and why they matter>

Acceptance criteria:
- <criterion>

Rules:
- Keep changes focused.
- Do not perform unrelated refactors.
- Report blockers clearly.
```

Read-only investigation prompt shape:

```text
Question:
<specific question>

Scope:
<files/directories/modules to inspect>

Rules:
- Do not modify files.
- Cite relevant file paths and symbols.
- Separate facts from guesses.
```

## After the worker responds

Always review the result before presenting it as verified.

For write-capable tasks, inspect changed files and run or explain relevant
tests. For read-only tasks, verify that important claims are supported by repo
evidence.

Be transparent in the final response:

```text
I used <profile>. It reported <summary>. I verified <checks>. Remaining risk:
<risk or none>.
```

Never hide that a subagent was used.

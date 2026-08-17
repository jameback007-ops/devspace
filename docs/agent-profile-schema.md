# Subagent profile schema

DevSpace agent profiles are user-owned markdown files with YAML
frontmatter. They describe roles such as reviewer, explorer, or implementer.
DevSpace owns provider invocation.

Profiles are discovered from:

- `~/.devspace/agents/*.md`
- `.devspace/agents/*.md`

Packaged files under `examples/agents/` are starter templates only.

## Minimal shape

```md
---
schema: devspace-agent/v1
name: reviewer
description: Read-only reviewer for bugs, security risks, and missing tests.
provider: codex
model: gpt-5.4
thinking: high
disabled: false
---

You are a read-only reviewer. Do not edit files.
Focus on correctness, security, test gaps, and maintainability.
Cite files and return concise findings.
```

## Frontmatter fields

### `schema`

Optional schema identifier:

```yaml
schema: devspace-agent/v1
```

### `name`

Stable profile identifier shown to the model and accepted by:

```bash
devspace agents run <name> "<prompt>"
```

Use lowercase kebab-case names. If omitted, DevSpace uses the filename without
`.md`.

### `description`

Required short purpose. This is exposed by `open_workspace` so the supervising
model can choose the right profile.

### `provider`

Required built-in provider id:

```yaml
provider: codex
provider: claude
provider: opencode
provider: pi
provider: cursor
provider: copilot
```

Unsupported or custom providers are rejected. DevSpace maps providers to their
native integration:

- `codex`: Codex SDK
- `claude`: Claude Code SDK
- `opencode`: OpenCode SDK
- `pi`: Pi RPC mode
- `cursor`: ACP
- `copilot`: ACP

### `model`

Optional provider model id or alias.

```yaml
model: gpt-5.4
model: sonnet
```

### `thinking`

Optional provider reasoning effort, thinking level, or model variant. If omitted,
DevSpace lets the provider default apply. Values are provider-specific
passthrough strings; DevSpace does not translate names between harnesses.

```yaml
thinking: low
thinking: high
thinking: xhigh
```

DevSpace passes this through to providers that expose a matching control:

- `claude`: SDK effort with adaptive thinking.
- `codex`: SDK model reasoning effort.
- `pi`: `--thinking`.
- `opencode`: model variant.
- `cursor` and `copilot`: ACP thought-level config when supported.

### `disabled`

Optional boolean. Disabled profiles are not exposed.

```yaml
disabled: true
```

## Markdown body

The body is the profile prompt prefix DevSpace prepends when launching that
profile. It is not included in `open_workspace` by default.

Recommended body content:

- When to use this profile.
- Whether the worker should act read-only or may make changes.
- Output format.
- Review or testing expectations.

## Model-facing workflow

The Subagent skill prefers the first-class local-agent MCP tools when visible
and otherwise uses the queue-backed CLI:

```bash
devspace agents ls
devspace agents run <profile-or-id> "<prompt>"
devspace agents show <id>
devspace agents turn <turn-id>
devspace agents cancel <turn-id> [note]
devspace agents resume <agent-id> [note]
```

`open_workspace` exposes compact profile metadata:

```json
{
  "name": "reviewer",
  "description": "Read-only reviewer for bugs, security risks, and missing tests.",
  "provider": "codex",
  "model": "gpt-5.4",
  "thinking": "high"
}
```

`devspace agents ls` lists existing subagent sessions for the current workspace;
it does not list profile definitions.

`agents run <existing-id>` enqueues a durable follow-up rather than launching an
overlapping provider process. Codex, Claude, OpenCode, and Pi resume the
provider session committed by the preceding successful turn. See
[Local-Agent Session Continuation](local-agent-continuation.md).

The full profile body stays out of the model context until DevSpace launches the
profile.

## Current non-goals

- Custom or arbitrary CLI-backed agents.
- Inferring changed files, tests, or diffs from worker output.
- Exposing raw provider transcripts by default.
- Teaching the model provider-specific CLIs.
- Claiming provider-session continuation where an adapter has not qualified a
  resume mechanism.

# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`devspace init` generates an Owner password and stores it in:

```text
~/.devspace/auth.json
```

When an MCP client connects, DevSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

DevSpace needs `DEVSPACE_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `DEVSPACE_PUBLIC_BASE_URL`.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Use `DEVSPACE_ALLOWED_HOSTS=*` only for intentional local debugging.

## Tunnels

DevSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. DevSpace OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Native File Download

Native file download is an opt-in, one-shot transfer into an already-open
workspace. `download_artifact` accepts the MCP host's native file value, the
`workspaceId` returned by `open_workspace`, and an unused relative destination
path. It returns only the workspace-relative path and does not create a
persistent artifact service or reusable artifact ID.

DevSpace accepts only the documented native-file object and trusted OpenAI
download hosts and redirects. Arbitrary URL strings, local source paths,
credentials, malformed references, and unknown object fields are rejected.

Absolute paths, traversal, symlinked parents, and existing destinations also
fail closed. Downloads stream under the configured per-file limit and are
published without overwrite as owner-only files. DevSpace does not extract or
execute transferred content.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.

Artifact tool logs contain bounded workspace ID, validated hostname,
workspace-relative output path, byte count, hash, duration, and status metadata.
`download_artifact` does not log the opaque file value. Raw content, connector
references, native file IDs, bearer credentials, presigned URLs, host paths,
temporary paths, and base64 chunks are never included in tool logs or tool
results.

## Cross-Session Observability

Execution-scope inspection is available only through the same authenticated
single-Owner MCP boundary as coding tools. It exposes an opaque hash-derived
scope reference rather than a raw host conversation ID. Raw host conversation
IDs are not persisted by the execution-scope observability tables; those tables
store only a full SHA-256 collision-check digest. Pre-existing workspace-reuse
bindings remain a separate storage contract.

The durable audit stores tool names, outcomes, timing, workspace/process
locators, selected bounded metadata, digests, and normalized error categories.
Arbitrary exception messages are not persisted. The audit excludes
transcripts, prompts, private reasoning, tool outputs, raw commands, patch and
edit bodies, native file values, credentials, and signed URLs. Inspection tools
do not audit themselves.

Process details are joined by exact execution-scope attribution rather than by
workspace alone. When scopes share a checkout, foreign or unattributed running
processes are represented only by a count.

Workspace roots and working directories may appear because the authenticated
Owner already has access to the allowed local roots. Sharing the same checkout
does not grant another scope writer authority; use worktrees and the project's
own writer/lease rules for concurrent work.

## Cross-Session Messaging

The execution mailbox is protected by the same authenticated single-Owner MCP
boundary. A sender cannot choose or spoof its sender identity; DevSpace derives
it from request metadata. The target must be an existing retained `scopeRef`.
Inbox reads and receipt mutation are target-bound, while message status is
visible only to the sender or target.

Unlike observability, mailbox delivery intentionally persists message body text.
Do not include credentials, bearer tokens, signed URLs, private model reasoning,
or unrestricted tool output. Use bounded durable references and let the target
read authoritative state through its normal tools. Observability records only
lengths and digests for mailbox body, note, and idempotency fields rather than
duplicating their text.

Idempotency keys are unique per sender. Reusing a key with a different payload
fails closed. Pending-message limits, TTL, terminal retention, strict target
binding, and monotonic receipts bound replay and queue growth. A mailbox wakeup
may end a pure process poll, but it does not interrupt the process, consume the
message, create a WebChat turn, or inject text into a host transcript.

## Local-Agent Provider Continuation

Local-agent billing defaults to `subscription_only`. DevSpace blocks known
API-key, custom-provider, cloud-provider, and BYOK overrides before provider
execution. Codex and Claude additionally require subscription-auth attestation;
OpenCode and Pi are unavailable until their adapters can pin and attest a
subscription-backed provider. The only bypass is the explicit
`DEVSPACE_LOCAL_AGENT_BILLING_MODE=payg_allowed` setting. Credential values are
never placed in availability errors or execution-scope audit.

Local-agent prompt bodies and final provider responses are intentionally
persisted in the owner-only SQLite database because they are the durable input
and output of provider-session continuation. Do not include credentials,
private reasoning, signed URLs, or unrestricted tool output. Execution-scope
audit records only bounded metadata, lengths, and digests for these calls.

One worker lease per agent prevents overlapping provider turns. The lease holder
renews while a provider call is active. A stale lease before provider admission
may safely requeue a claimed turn; a stale lease after provider execution began
marks the turn `indeterminate` and blocks later turns. DevSpace never
automatically replays an unknown provider effect.

An unexpired lease is scheduling evidence, not an OS-process liveness claim.
Status therefore exposes lease activity and expiry rather than asserting that a
worker process is alive.

Provider output that arrives after worker authority becomes uncertain is stored
only as candidate evidence on the indeterminate turn. It does not update the
agent's active provider session or latest response until an explicit succeeded
resolution. Oversized candidate responses retain length and digest without the
body.

Running cancellation uses the provider's best available native mechanism, but
remains `cancel_requested` until execution terminates. Successful completion
after a cancellation request remains successful. Explicit indeterminate
resolution is available only through the same authenticated single-Owner MCP
or local CLI boundary and may require external Git, runtime, or effect evidence.

Cursor and Copilot ACP adapters are not advertised as resumable provider
sessions in this version. DevSpace rejects follow-up continuation rather than
silently starting a new unrelated session.

## Advisory Turn Continuity and Recovery Capsules

Conversation identity is not a safe clock for one assistant turn, and DevSpace
does not infer a platform cutoff from elapsed conversation time. The retired
executor-window mechanism is not a security boundary and no longer blocks
mutation or command execution. Recovery and duplicate-effect prevention remain
the responsibility of the actual workspace, process, provider, product writer,
and effect/lease contracts.

The replacement turn horizon is advisory only. Exact turn and deadline metadata
is accepted only at the MCP adapter edge; raw turn identity is not persisted.
Without exact metadata, the model explicitly begins one advisory epoch. A notice
cannot disable a tool, force a commit, authorize a retry, or lower validation.

Recovery capsules intentionally persist bounded semantic handoff text in the
owner-only SQLite database. Do not include credentials, signed URLs,
transcripts, private reasoning, or unrestricted tool output. Idempotency keys
are stored only as digests. The capsule is bound to hashed Git state and can be
read across retained execution scopes only after the caller opens the exact
allowed workspace root. It never grants writer, task, effect, publication, or
canonical-memory authority. Local Git freshness is not canonical freshness:
another worktree or executor may advance Git/main, PostgreSQL, writer, runtime,
or effect state while the recorded workspace remains unchanged. Exact action
reliance therefore requires freshly rehydrated authority-state refs to match the
recorded baseline. Time or TTL alone is neither freshness nor invalidation
evidence; live owner readback remains required.

An optional Codex session adapter is also not an executor-plane boundary. Its
transport or thread may be degraded while DevSpace filesystem, process, and VPS
execution remain healthy. Status responses therefore keep adapter transport,
thread lifecycle, direct-input capability, and persistence freshness separate.

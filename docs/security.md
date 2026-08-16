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

## Executor-Turn Boundary

Conversation identity is not a safe clock for one assistant turn. Hard
executor-window enforcement is enabled only when the host supplies an exact
`devspace/executor-turn` value that changes between turns. Without that host
boundary, explicit and automatic windows are advisory and roll over instead of
blocking a later conversation turn. This avoids converting an interruption
warning into a persistent denial of mutation.

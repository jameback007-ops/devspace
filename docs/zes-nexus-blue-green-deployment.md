# ZES Nexus blue/green deployment

ZES Nexus must not make an ordinary product deployment synonymous with an MCP
disconnect. The production endpoint therefore uses two loopback slots behind
Caddy. Only one slot receives new traffic; the other may be staged and probed
before an atomic proxy switch.

The fixed production ports are conventionally `7677` and `7678`. Both slots
share the durable DevSpace state directory. OAuth clients, access/refresh token
hashes, authorization codes, workspaces, and other SQLite-backed executor state
therefore survive a slot replacement. Process-local sessions are deliberately
not treated as portable state, so cutover is held while the active backend's
`/readyz` reports `restartSafety.state != safe`.

Install `examples/systemd/devspace-zesnexus-slot@.service` as
`/etc/systemd/system/devspace-zesnexus-slot@.service`. Keep common, non-secret
runtime settings in `/etc/devspace/devspace-zesnexus-runtime.env`; keep each
slot's `PORT`, `DEVSPACE_RELEASE_ROOT`, and release-bound tool-surface identity
in `/etc/devspace/devspace-zesnexus-slot-blue.env` and
`/etc/devspace/devspace-zesnexus-slot-green.env`. Secrets remain in the existing
systemd credential and owner-token paths.

Caddy imports one small generated file inside the `mcp.zesnexus.com` site:

```caddyfile
import /etc/caddy/zes-nexus-upstream.caddy
```

The imported file contains exactly one loopback upstream, for example:

```caddyfile
reverse_proxy 127.0.0.1:7677
```

For a deployment, start the inactive slot first. Probe it directly. Then run
`scripts/zes-nexus-blue-green-cutover.mjs` from an execution plane that is not
the active Nexus service itself. The cutover gate requires the active backend to
be restart-safe, the candidate to be `READY`, database/tool-surface identity not
to regress, and OAuth discovery to advertise `offline_access`. It atomically
rewrites the upstream include, validates and reloads Caddy, verifies the public
endpoint reached the candidate backend, and rolls the proxy file back if public
readback fails.

Do not stop the old slot at the same time as the proxy switch. Let existing
requests drain, observe the old slot from an independent supervisor, and retire
it only when no process-local continuation or material effect still depends on
it. The next deployment reuses the retired port as the inactive slot.

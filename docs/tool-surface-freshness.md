# Tool-Surface Freshness and Deployment Attestation

DevSpace ZES Nexus exposes two facts that must not be conflated:

1. the exact tool descriptors registered by the running backend; and
2. the tool catalog currently cached by an MCP host such as WebChat.

The backend can prove the first fact. An ordinary tool call does not carry the
host's cached `tools/list` response, so the backend cannot infer the second.
Missing host-visible tools therefore do not prove that the backend lacks the
capability.

## Exact surface identity

The surface fingerprint is SHA-256 over canonical JSON for the complete MCP
`tools/list` descriptors, sorted by tool name. It includes:

- name, title, and description;
- complete input and output JSON Schemas;
- annotations;
- MCP execution metadata; and
- complete `_meta`, including both current MCP Apps UI metadata and its legacy
  compatibility key.

Hashing only tool names or a locally approximated schema is insufficient. A
server integration regression test compares the registry descriptor set with a
real SDK `Client.listTools()` result before accepting the fingerprint.

## Deployment manifest

`zes.tool-surface-deployment-manifest.v1` binds one expected deployment to:

- source commit and source tree;
- deterministic digest of the complete built server artifact tree;
- package version and MCP server version;
- exact tool fingerprint, count, and names;
- surface epoch;
- the governed execution-accelerator profile identity;
- exact expected native MCP identities, when they are observable; and
- the client tools required for safe operation.

The running process loads the manifest from
`DEVSPACE_TOOL_SURFACE_MANIFEST` and verifies its complete file digest against
`DEVSPACE_TOOL_SURFACE_MANIFEST_SHA256`. A path without a digest pin is not a
qualified deployment attestation.

Native MCP identities must come from exact activation/configuration receipts or
runtime observations. An empty array means that no native MCP is bound by this
executor-local manifest. It must not be replaced with names inferred from a
host UI or a repository profile.

## Status model

| Status | Meaning |
| --- | --- |
| `CURRENT` | Server deployment and a complete client catalog attestation both match the manifest. |
| `SERVER_CURRENT_CLIENT_UNKNOWN` | Server deployment matches, but the client did not attest its complete descriptor fingerprint. |
| `STALE_SERVER` | Source, build, surface, profile, or required native MCP differs from the manifest. |
| `STALE_CLIENT` | Server is current but the client attested a different epoch, fingerprint, or required-tool set. |
| `INDETERMINATE` | Required deployment evidence is absent, invalid, unpinned, or unobservable. |

The assessment is executor-local observation only. It does not release a task,
grant writer authority, authorize publication, or prove downstream effects.

## Probe and manifest generation

### Recovery diagnosis is not a permission request

The `execution_scope_status` recovery projection evaluates only the caller's
declared `requiredCapabilityRefs`; omission evaluates bootstrap, not an inferred
mission. A current server with no client inventory reports required tools as
`unobservedRequiredTools`, not `missingRequiredTools`. Its next step is
`ATTEST_CLIENT_CATALOG`, with `clientCatalogAttestationRequired=true`, not a
server restart or a claim that the tool is absent. Observed partial inventories
still reveal real missing names and request a bounded catalog refresh. Neither
path authorizes a permission change or blocks unrelated capabilities.

Read-only stable projections already returned by the successful bootstrap call
remain usable without a complete client-catalog attestation. This does not
attest missing direct tools, permit effect replay, or release publication gates.

Research requirements follow the server's configured contract. When the research
cycle is off, `research_freshness` checks the native `research` surface. When the
cycle is enabled, its complete cycle tool requirements remain mandatory; native
acquisition alone does not discharge cycle obligations. Registration is not a
provider-health, evidence-quality or mission-completion claim.

`permissionBoundaries` separates three independent layers without changing them:

- Host app permission and host safety review are not observable by Nexus.
- Direct DevSpace workspace execution does not traverse Codex approvals.
- Native Codex approval applies only to Codex gateway operations. Its
  `autoApproval=false` describes the relay's refusal to approve automatically,
  not evidence that an observed host popup originated in Codex. Inspect an exact
  native pending request before diagnosing that layer.

Do not translate host Full Access into `approvalPolicy=never`, widen a sandbox,
or reroute a safety-denied operation as a catalog repair. Record the exact tool,
time, failing layer and error category. A host-side tool-not-found, an expired
process session, an OS command-not-found and a permission denial require different
repairs. A successful retry or another session's success does not prove that the
original host failure has been repaired.

Official context: OpenAI's [developer-mode app documentation](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
and [sandbox/approval documentation](https://developers.openai.com/codex/sandboxing)
describe host app lifecycle and Codex execution boundaries separately. Updating
the server cannot attest that ChatGPT has refreshed its imported app metadata.

### Generate the exact configured surface

Run the probe with the same feature flags as the target service. The probe uses
temporary state and an in-memory MCP transport, so it does not mutate the live
workspace registry or require a network listener.

```bash
set -a
. /etc/devspace/devspace-zesnexus.env
set +a

npm run tool-surface:probe -- \
  --output /var/lib/devspace-zesnexus/tool-surface-probe.json
```

After building a clean committed source tree, generate the manifest:

```bash
npm run tool-surface:manifest -- \
  --probe /var/lib/devspace-zesnexus/tool-surface-probe.json \
  --output /etc/devspace/tool-surface-deployment.json \
  --source-commit "$(git rev-parse HEAD)" \
  --source-tree "$(git rev-parse 'HEAD^{tree}')" \
  --build-artifact "$PWD/dist" \
  --surface-epoch "nexus:$(git rev-parse --short=12 HEAD)" \
  --accelerator-profile /path/to/repository-execution-accelerator-profile.yaml \
  --accelerator-profile-ref 'git:repository@commit:release/repository-execution-accelerator-profile.yaml'
```

The generator recomputes the complete descriptor fingerprint, hashes the full
build tree (relative paths, file modes, sizes, and file digests) and profile
file, validates all required client tools, writes the manifest
atomically, and writes a sibling `.sha256` file. It refuses a probe whose saved
fingerprint does not match its descriptors.

## Runtime observation

`/healthz`, MCP response headers, `execution_scope_list`, and
`execution_scope_status` expose the assessment. Responses carry:

- `Cache-Control: no-store`;
- `X-ZES-Nexus-Instance-Ref`;
- `X-ZES-Tool-Surface-Fingerprint`;
- `X-ZES-Tool-Surface-Epoch`; and
- `X-ZES-Tool-Surface-Freshness`.

A client or operator probe may attest its observation with
`X-ZES-Client-Tool-Surface-Fingerprint` and
`X-ZES-Client-Tool-Surface-Epoch`, or with the optional matching fields on the
existing execution-scope status tools. Partial tool-name evidence can prove
that required tools are missing, but it cannot prove `CURRENT`; that requires
the complete canonical descriptor fingerprint.

## Restart and notification boundary

`notifications/tools/list_changed` is appropriate only when the connected
server instance performs a real authorized in-process registration change. A
service restart creates a new MCP instance and does not guarantee that a host
will refresh a previously cached catalog. During a deployment restart:

1. prove an independent fallback MCP path;
2. notify active scopes to use that fallback and reach a safe checkpoint;
3. preserve rollback evidence;
4. restart only Nexus through the fallback path;
5. verify source, build, manifest digest, profile, exact surface, headers, and a
   real MCP call; and
6. notify scopes to return to Nexus.

If the backend is current but WebChat still exposes an old catalog, refresh or
reconnect the MCP connector. Do not rebuild the backend capability from the
stale client view.

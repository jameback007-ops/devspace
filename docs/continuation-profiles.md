# Fixed continuation profiles

The MCP tool name and its five intent values are unchanged. Profile and target
selection belong to the host deployment, not tool arguments or a caller-selected
command. There is no automatic fallback between runtime and repository evidence.

## Current Cleanroom construction

Honor the existing deployment setting `DEVSPACE_ZES_CONTINUATION_BACKEND=repository_only` and explicitly set
`DEVSPACE_ZES_REPOSITORY_ROOT` to the intended current Cleanroom checkout.
The existing executable `<root>/zes-continuation --summary` supplies the native
`zes.cleanroom.repository-continuation.v1` readback. Nexus validates the contract,
workspace, observation time and source hashes with resolved-root containment.
It neither reimplements the research/control rules nor constructs a runtime
preflight from Git cleanliness. The same root selects the existing scope-linked
publication assessor's fixed remote identity; deployment must verify that identity.

The direct call reads fresh source. The stable embedded projection uses its
existing bounded cache and explicitly calls its horizon `cacheUntil`, not
source or authority expiry. Repository output keeps its original schema and
dirty/current-source observations. Runtime state and remote freshness remain
unobserved by that reader.

`inspect` reports observation. Other intents report `not_assessed`, with no new
authority and no inferred policy denial. `publish_repository` identifies the
existing `execution_scope_status` → `stableControlPlane.capabilities.scopePublicationPreflight`
candidate-bound route. Preparation and shared writes use current owner direction
and exact source-overlap reconciliation. Runtime takeover/retry uses the actual
native runtime/effect owner. Source observation is not a substitute for any of
those decisions, and a real denial must never be treated as this unassessed case.

## Existing runtime deployments

The default `legacy_runtime` retains the known v2/v3 product-control contract and
its explicit Python/locator/state-root settings. Existing consumers do not gain a
new required input. A removed Blueprint interpreter is an unavailable legacy
route, not a Cleanroom policy denial. Restoring that interpreter or forging its
envelope is not necessary for repository construction. Select the appropriate
profile deliberately; unknown values and repository mode without an explicit
root fail rather than silently choosing another world.

The prior df35097 deployment already selected `repository_only` in slot.env,
but the old adapter ignored it and still invoked Blueprint's removed interpreter.
This change implements that existing selection, rather than adding a second
profile environment variable or manufacturing a v3 product envelope.

## Verification and basis

Tests cover all existing intent values, source/projection separation, explicit
profile selection, native command exit, incorrect contracts/workspaces, missing
or changed bindings, timestamp replay and symlink escape. Existing legacy and
scope-publication tests remain applicable. Source-level native-reader use does
not prove deployment or an existing host's next call.

The protocol basis is the official [MCP tools contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools):
execution errors remain tool errors, not successful policy evaluations. Node's
[child-process contract](https://nodejs.org/docs/latest-v24.x/api/child_process.html)
explains why a missing command or working directory produces ENOENT. Explicit
profile routing repairs the responsible adapter boundary; it does not weaken
authorization, shell containment, output bounds or unknown-effect handling.

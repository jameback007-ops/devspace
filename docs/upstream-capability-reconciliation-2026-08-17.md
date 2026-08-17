# DevSpace Upstream Capability Reconciliation

Date: 2026-08-17  
Scope: `jameback007-ops/devspace` / ZES Nexus executor harness  
Purpose: prefer mature upstream mechanisms, remove unnecessary custom engine
ownership, and identify useful upstream capabilities that are not yet active in
the ZES Nexus deployment.

## Evidence baseline

The audit compared the deployed ZES fork with the current upstream main and the
relevant open upstream pull requests.

- Upstream repository: `Waishnav/devspace`
- Upstream main: `b5b4ab62a8718e1186aef815538741d9402f92ba`
  (`v1.0.7`)
- ZES fork baseline: `8c45cb38e817f0a13f76eb6833fed367f0960806`
- Fork divergence at audit time: 14 commits ahead, 0 commits behind upstream
  main
- Deployed tool mode: `codex`
- Deployed widget mode: `off`
- Skills, subagents, artifacts, execution observability, execution mailbox,
  turn continuity, and subscription-only local-agent billing are enabled

The fork therefore does **not** miss a released upstream source revision. The
main reconciliation problem is instead:

1. stable upstream mechanisms present in source but hidden by the selected tool
   mode or deployment configuration;
2. useful upstream work that exists only in unmerged pull requests;
3. custom ZES layers that partially overlap those pending upstream designs.

Pull-request status in this document is a dated observation, not a permanent
claim. Re-check the upstream head, review state, and CI before adoption.

## Classification rules

| Classification | Required action |
| --- | --- |
| `REUSE_NATIVE` | Use the upstream implementation directly and delete or avoid a parallel mechanism. |
| `WRAP_NATIVE` | Keep only a narrow adapter, policy, or semantic projection around the upstream owner. |
| `COMPOSE` | Keep both because they operate at different scopes or reliance boundaries. |
| `KEEP_CUSTOM` | Retain the custom capability because upstream has no equivalent owner or the semantics are materially different. |
| `DEFER` | Do not adopt yet; define explicit maturity and migration gates. |
| `REJECT` | Do not import because it creates an authority conflict or belongs to another product layer. |
| `REMOVE_SHADOW` | Delete a competing custom engine or authority once a qualified native replacement exists. |

Capability similarity alone is not a reason to remove a component. The audit
asks who owns execution, persistence, recovery, policy, and authoritative state
at the exact boundary in question.

## Stable upstream capability inventory

| Capability | Upstream state | ZES state before this round | Decision |
| --- | --- | --- | --- |
| Workspace registry and conversation-scoped reuse | Released and active | Used directly | `REUSE_NATIVE` |
| Checkout and isolated Git worktree lifecycle | Released and active | Used directly | `REUSE_NATIVE` |
| Workspace-root containment and path validation | Released and active | Used directly | `REUSE_NATIVE` |
| Direct file read | Released and active | Used directly | `REUSE_NATIVE` |
| Codex-style patch application | Released in `codex` mode | Used directly | `REUSE_NATIVE` |
| Persistent command/process sessions | Released in `codex` mode | Used directly with a small output-aware polling improvement | `WRAP_NATIVE` |
| Native `grep`, `glob`, and `ls` handlers | Released in `full` mode | Present in source but hidden in deployed `codex` mode | `REUSE_NATIVE` — exposed by an opt-in composition flag in this round |
| Aggregate Git review checkpoints and `show_changes` | Released, tied to `widgets=changes` | Disabled because deployment uses `widgets=off` | `DEFER` — reuse native only after checkpoint hardening is qualified; do not build another diff engine |
| Agent and nested instruction discovery | Released | Used directly | `REUSE_NATIVE` |
| Contextual skill discovery | Released | Used directly | `REUSE_NATIVE` |
| Metadata-only on-demand `skill_search` | ZES extension over native skill data | Active | `COMPOSE` — retain as a thin discovery layer, not a second skill runtime |
| Native artifact download | Released and opt-in | Enabled | `REUSE_NATIVE` |
| Local-agent profiles and provider adapters | Released/experimental substrate | Used by the ZES durable turn coordinator | `WRAP_NATIVE` |
| OAuth, MCP transport, and session tracking | Released | Used directly | `REUSE_NATIVE` |

### Immediate activation: native navigation in Codex mode

The upstream `grep`, `glob`, and `ls` handlers already provide bounded,
workspace-relative, ignore-aware inspection. The ZES deployment previously used
`exec_command` plus shell utilities for all search and directory discovery
because `DEVSPACE_TOOL_MODE=codex` did not register these handlers.

This round adds `DEVSPACE_CODEX_NAVIGATION_TOOLS=1`. It registers the existing
upstream handlers while retaining the Codex-native mutation and process surface:

- `apply_patch` remains the only generic file mutation tool;
- `exec_command` and `write_stdin` remain the process engine;
- no new search, shell, workspace, Git, or process implementation is created;
- the option is off by default to preserve existing installations and tool
  schemas.

## Custom-layer reconciliation

| ZES component | Exact responsibility | Upstream overlap | Decision |
| --- | --- | --- | --- |
| `process-sessions.ts` ZES changes | Output-aware polling, bounded wait, scope-safe process inspection | Extends the released upstream process-session owner | `WRAP_NATIVE`; keep the delta small and upstreamable |
| `execution-observability.ts` | Metadata-only view joining MCP tool lifecycle, native workspaces, and native process sessions | Upstream exposes the underlying sessions but not this cross-scope semantic view | `COMPOSE`; it must remain read-only and non-authoritative |
| `execution-mailbox.ts` | Durable target-bound executor-local messages with receipts and idempotency | No released upstream equivalent | `KEEP_CUSTOM`; not a task, memory, decision, or effect authority |
| `turn-continuity.ts` | Advisory turn horizon and explicit Git-bound recovery capsules | Review checkpoints cover diffs, not semantic recovery or authority reconciliation | `KEEP_CUSTOM`; remain advisory-only and never gate tools or force completion |
| `zes-codex-inspection.ts` | Read-only adapter for the allowlisted external Codex AOQ session and worktree | No released generic upstream equivalent | `KEEP_CUSTOM`; keep isolated from DevSpace workspace health and product authority |
| `skill_search` extension | On-demand metadata routing for host-global niche skills | Composes with native skill discovery/loading | `COMPOSE`; native loader remains the skill execution owner |
| `local-agent-queue.ts` and `local-agent-coordinator.ts` | Durable serialized turns, leases, idempotency, fail-closed billing, indeterminate-effect reconciliation | Material overlap with the pending upstream daemon/pool/runtime stack | `DEFER` migration; freeze expansion into provider-runtime ownership and prepare a thin-policy wrapper boundary |

No released upstream engine was found to be shadowed wholesale by the current
ZES custom modules. The highest-risk overlap is local-agent runtime ownership,
but the candidate replacement is still an unmerged upstream PR stack rather
than a qualified released subsystem.

The previous `executor-window` state machine was correctly removed. It was a
custom control mechanism that could gate work based on a host turn estimate;
the remaining continuity mechanism is advisory and preserves native executor
availability.

## Upstream candidates not yet in the released baseline

### 1. Local-agent daemon, runtime pool, and warm continuation — PRs #183–#188

**Value**

- moves provider runtime ownership out of the MCP server process;
- adds private IPC, startup locking, restart recovery, runtime pooling, and warm
  continuation;
- directly addresses lifecycle durability that should not be reimplemented in
  the ZES policy layer.

**Overlap**

This stack overlaps the engine half of `local-agent-coordinator.ts`. ZES still
needs its subscription-only billing policy, turn idempotency, effect uncertainty
handling, and non-authority boundary, but it should not permanently own a second
provider runtime daemon if upstream supplies a qualified one.

**Decision: `DEFER`, then `WRAP_NATIVE`**

Do not deepen custom provider process ownership. Adopt only when the complete
stack has a stable upstream base, all supported-platform CI passes, requested
reviews are resolved, crash/restart semantics are documented, and migration of
queued/indeterminate turns is proven. At that point:

1. upstream owns daemon, provider process, pool, and continuation transport;
2. ZES retains billing and authority policy plus durable turn admission;
3. remove any ZES provider-runtime code made redundant by the upstream owner.

### 2. Bounded nested instruction discovery — PR #197

**Value**

- bounds directory traversal, file count, file size, and discovery latency;
- protects `open_workspace` from pathological or unexpectedly broad roots.

**Current relevance**

The deployment currently permits `/` as an allowed root. Exact workspace paths
still preserve containment, but broad discovery requests can traverse much more
than a normal project tree. This makes bounded discovery valuable.

**Decision: `DEFER`**

Do not independently recreate the scanner. Re-evaluate when upstream CI and
deadline handling are clean. In parallel, inventory the exact project roots
needed by ZES and replace `DEVSPACE_ALLOWED_ROOTS=/` with a minimal explicit set;
that configuration change requires its own access regression test.

### 3. Git review checkpoint hardening — PR #178

**Value**

- improves `show_changes` behavior for nested repositories, unborn branches,
  restarts, and checkpoint edge cases.

**Decision: `DEFER`, then `REUSE_NATIVE`**

Keep widgets off and do not expose a separate custom diff/review engine. Adopt a
qualified hardening revision, then decouple headless review availability from
iframe widgets if upstream has not already done so. Preserve bounded output and
fail clearly when checkpoint history cannot be reconstructed.

### 4. Modern MCP protocol negotiation — PR #201

**Value**

- supports the newer MCP protocol revision and client negotiation used by
  current ChatGPT clients.

**Decision: `DEFER`**

The current connector is operational. Protocol changes affect initialization,
session lifecycle, request handling, and shutdown, so adopt only from a clean,
reviewed upstream revision with real-client compatibility tests. Do not maintain
a permanent ZES protocol fork.

### 5. OAuth client-registration recovery — PR #135

**Value**

- recovers known client registrations after local OAuth state loss;
- can reduce reconnect failures after state migration or corruption.

**Decision: candidate `REUSE_NATIVE` in a focused operational change**

This PR was comparatively mature at the audit snapshot, but it changes the
authentication path rather than the coding harness. Port or merge it separately
with OAuth migration, negative security, restart, and ChatGPT reconnect tests.

### 6. Bounded duplicated MCP tool output — PR #85

**Value**

- reduces repeated payloads across text, structured content, and UI card
  channels;
- can lower context pressure for large search, diff, and command results.

**Decision: `DEFER`**

The proposal was draft/dirty at the snapshot. Reuse the upstream response
normalization design once stable rather than adding another ZES-wide output
engine. Existing process-session output bounds remain valid because they govern
the native process buffer, not MCP response-channel duplication.

### 7. Allowed-root catalog — PR #177

**Value**

- lets clients discover configured workspace roots.

**Decision: do not activate yet**

With the current root set to `/`, the catalog would provide little navigation
value and encourage overly broad workspace selection. Tighten roots first, then
reassess.

### 8. MCP client access policy — PR #84

**Value**

- can restrict which MCP client types may use a deployment.

**Decision: optional security hardening**

Adopt only after defining whether ChatGPT, Codex, and other clients should share
the endpoint. This is an access-policy decision, not a harness engine feature.

### 9. Dynamic workflows and workflow UI — PR family #94 and descendants

**Decision: `REJECT` for ZES Nexus product authority**

DevSpace may retain executor-local workflow conveniences, but importing a
durable product workflow owner would overlap Hermes/Hatchet/ZES orchestration
authority. Borrow isolated UI or executor patterns only when they do not create
a second task, decision, writer, or effect truth.

## Adoption order

1. Activate and validate native navigation tools in `codex` mode.
2. Tighten allowed roots after a complete path/access inventory.
3. Track upstream bounded instruction discovery and Git review hardening; adopt
   only qualified upstream revisions.
4. Define the local-agent runtime seam now, but wait for the daemon/pool stack to
   stabilize before migration.
5. Upgrade MCP protocol and OAuth recovery in focused transport/security
   changes, not mixed into agent-runtime work.
6. Adopt upstream-wide output normalization only after its response semantics
   stabilize.

## Required gate for future custom harness work

Before adding a major executor-harness mechanism:

1. inspect upstream main, open PRs, and release notes for the exact capability;
2. compare semantics, authority, persistence lifetime, failure behavior, and
   performance rather than feature names;
3. prefer `REUSE_NATIVE`, then `WRAP_NATIVE`, then `COMPOSE`;
4. permit a new custom engine only with evidence that no qualified native owner
   exists and document its retirement seam;
5. never import an upstream executor convenience as ZES canonical product
   authority;
6. record the upstream commit/PR head, deployment flags, tests, and migration
   decision in the same change.

## Audit conclusion

The current ZES Nexus harness has not yet crossed into wholesale reimplementation
of the released DevSpace execution engine. Its generic workspace, Git, patch,
process, instruction, skill, artifact, OAuth, and MCP substrate remains upstream
owned.

The immediate missed-native capability was dedicated workspace navigation in
`codex` mode, now addressed through composition. The principal future
de-customization target is local-agent provider-runtime ownership once the
upstream daemon/pool work is qualified. All other custom components should stay
bounded to semantic observability, policy, coordination, recovery, or external
adapter responsibilities and must not become shadow product authorities.

# Workspace Candidate Lifecycle

Parallel coding sessions are useful only when their Git state remains visible
after the model turn ends. DevSpace therefore treats a managed worktree as a
candidate with an explicit lifecycle, not as a disposable directory.

## Durable preservation

Every newly-created managed worktree receives an executor-owned local branch:

```text
devspace/workspaces/<workspaceId>
```

The workspace ID is allocated before `git worktree add`, and the branch is
created atomically at the selected base commit. The worktree is not detached.
If an older detached workspace is explicitly closed with committed publication
debt, DevSpace first adopts the same preservation-ref form at the exact observed
HEAD. Dirty state is never discarded, including when `force=true`.

## Inventory states

`workspace_candidate_inventory` reads managed worktrees, closed sessions with
retained preservation refs, execution-scope activity, exact Git state, and the
latest Git-bound recovery capsule. It reports one of these dispositions:

| Disposition | Meaning |
| --- | --- |
| `dirty_recoverable` | Uncommitted work exists and must be resumed or handed off. |
| `unanchored_candidate` | HEAD is not reachable from a persistent ref. |
| `awaiting_validation` | Candidate commits exist, but exact HEAD-bound validation is missing or stale. |
| `ready_to_publish` | Clean candidate and current validation exist; repository-specific publication preflight is still required. |
| `needs_reconcile` | Candidate and local authority have both advanced. |
| `integrated` | Candidate is in authority history or all non-merge patches are already equivalent there. |
| `baseline_only` | Candidate HEAD equals the selected local authority ref. |
| `unknown` | Git identity or local authority could not be established safely. |

Operational state is separate from Git disposition. Recent linked-scope
activity, a running DevSpace/operating-system process, a loaded workspace, or an
explicit capsule writer/effect state can retain deletion finalizers even when a
candidate is already integrated.

The inventory includes bounded explicit capsule semantics such as mission,
frontier, exact next action, unresolved items, checkpoint refs, and linked
execution-scope refs. It never infers task meaning from filenames or tool calls.

## Validation binding

A candidate is validation-ready only when the latest recovery capsule says
`validationState=passed`, contains at least one validation evidence ref, and its
stored Git fingerprint matches the exact current HEAD and dirty state. A passed
claim for another commit does not carry forward.

## Close and garbage collection

`workspace_close` and digest-bound GC use candidate lifecycle finalizers:

- dirty state is never removed;
- committed publication debt is retained, not silently deleted;
- a forced close may remove a clean worktree while retaining its preservation
  branch as a branch-only candidate;
- integrated or baseline-only candidates can be removed after operational
  finalizers clear;
- executor-owned preservation refs are deleted with an exact expected-HEAD
  compare-and-swap only after terminal integration;
- GC recomputes the lifecycle digest immediately before every removal.

`force` does not mean discard. It only permits a clean, anchored candidate to
leave the filesystem while its publication debt remains recoverable by ref.

## Fixed DevSpace self-publication

The optional `self_repository_publication_preflight` route governs publication
of DevSpace's own repository. Its repository root, remote, branch, and expected
remote URL are fixed server configuration; the model supplies only a registered
workspace ID.

Preflight requires:

- exact configured repository and remote identity;
- fresh `git ls-remote` authority;
- a clean exact candidate commit;
- current candidate-bound validation evidence;
- an explicit released/none writer state, terminal/none effect state, and
  `safeToPublish=true` attestation in the exact Git-bound recovery capsule;
- zero commits behind remote authority;
- no merge commits in the candidate range;
- a digest-bound exact-candidate refspec and expected-old lease.

When effects are separately enabled, `self_repository_publish` re-runs the
preflight, re-reads remote authority immediately before the effect, pushes the
exact candidate object with `--force-with-lease`, and derives success from a
second remote readback. It then mirrors the verified remote authority into the
local remote-tracking ref so terminal candidate cleanup can proceed without
moving a checked-out local `main` branch.

The preflight is also projected through
`execution_scope_status.stableControlPlane` so a client with a frozen MCP tool
catalog can inspect the fixed publication contract before reconnecting. That
stable read-only projection performs fresh `ls-remote` authority observation but
never imports a missing Git object. When comparison would require an object that
is not already local, it returns an explicit `use_direct_preflight` blocker; the
direct preflight may then fetch only that fixed configured authority object.

## Authority boundary

Lifecycle inventory and recovery capsules are executor-local observation. They
do not grant task completion, product decision, writer, effect, canonical Git,
or publication authority. Repository-specific preflight and exact remote
readback remain mandatory before publication.

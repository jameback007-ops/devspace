# ZES Research Reflex execution cycle

DevSpace can bind material work in a ZES checkout to the native ZES Research
Reflex v2 admission contract. The adapter owns only executor-local lifecycle,
receipt verification, and effect observation. It does not become a second
research engine or grant task, semantic, writer, publication, release,
activation, runtime, or effect authority.

The feature is disabled by default and applies only when both conditions hold:

1. `DEVSPACE_ZES_RESEARCH_CYCLE_MODE` is `observe` or `enforce`; and
2. the opened workspace contains
   `packages/zes-control-kernel/pyproject.toml`.

Generic DevSpace workspaces are unchanged.

## Lifecycle

The model-facing flow is:

1. `zes_research_cycle_open` records the material decision question, initial
   research-depth hypothesis, known local evidence, uncertainty, falsifier,
   reopen trigger, candidate paths, and actor identity against a clean Git
   baseline in enforce mode.
2. `zes_research_cycle_prepare` binds the exact Git repository identity, HEAD,
   tree, working-content digest, path prefixes, operation classes, evidence
   regime, source identity, decision scope, implementation boundary, action
   scope, and every exact shell command expected to mutate source or dependency
   files. Only command digests are persisted.
3. `zes_research_cycle_assess` invokes the fixed native
   `zes-research-reflex assess` application port. DevSpace stores and hashes the
   returned v2 receipt and lease; it does not recompute sufficiency.
4. `zes_research_cycle_invalidate` reopens judgment after counterevidence,
   architecture or semantic forks, dependency/upstream changes, owner direction
   changes, repeated distinct failures, scope drift, or source-currentness
   expiry.
5. `zes_research_cycle_verify_pre_commit` re-verifies the native receipt and
   binds the complete current working-content digest, validation refs,
   currentness checks, assumptions, limitations, unresolved risks, and stopping
   reason.
6. The normal Git commit is observed. A successful commit is accepted by the
   lifecycle only when it contains the complete pre-commit-verified change set.
7. `zes_research_cycle_close` records the terminal outcome, decision delta,
   reusable findings, and reversal conditions. Fresh or reused external
   research must also compile a native Research Reflex episode packet for
   Task N→N+k reuse.

Publication remains separately governed. The research cycle merely requires a
closed, committed, clean, exact-HEAD lifecycle before a publication command can
proceed through this gate.

## Modes

`off` registers no research-cycle tools and performs no checks.

`observe` registers the tools and records lifecycle signals. Guard findings are
returned as advisory but do not block the underlying DevSpace operation. If a
direct mutation crosses the prepared path or dependency boundary, the cycle is
set to `reassessment_required`.

`enforce` fail-closes source mutation, commit preparation, commit, and
publication when the exact current admission, scope, lease, pre-commit
checkpoint, commit, or closure is absent or stale. Read-only inspection,
validation, and research-control commands remain usable before a cycle exists.
Runtime effects are never authorized by research admission and remain held by
this gate until handled through the rightful runtime/effect control plane.

## Tool-bound enforcement

The adapter is wired into the normal DevSpace execution paths rather than a
parallel implementation:

- `apply_patch`, `write`, and `edit` guard exact workspace-relative paths and
  record the paths actually changed;
- `exec_command` and `bash` classify commands before dispatch and observe
  terminal outcomes;
- shell source/dependency mutation must match an exact command digest prepared
  before native admission; unknown or changed commands are held in enforce mode;
- dependency-changing shell commands additionally require the
  `dependency_change` operation class;
- long-running `exec_command` processes retain their original command binding
  across `write_stdin` polls;
- non-empty interactive input is conservatively checked before it is sent;
- two distinct failed commands after admission trigger typed reassessment;
- observation failure after an already completed effect returns an explicit
  indeterminate warning and never recommends blind replay.

The command classifier is deliberately conservative. Unknown commands are
treated as potentially mutating and require an exact prepared command digest in
enforce mode. It is a safety boundary, not a shell parser or proof that an
arbitrary command is side-effect-free. Prefer `apply_patch`, `write`, or `edit`
for ordinary source changes because those tools can be held against exact paths
before the effect.

## Configuration

```text
DEVSPACE_ZES_RESEARCH_CYCLE_MODE=observe
DEVSPACE_ZES_RESEARCH_REPOSITORY_ROOT=/srv/zes-codex/ZES-SYSTEM-BLUEPRINT
DEVSPACE_ZES_RESEARCH_STATE_ROOT=/var/lib/devspace-zesnexus/zes-research-cycles
DEVSPACE_ZES_RESEARCH_TIMEOUT_SECONDS=60
DEVSPACE_ZES_RESEARCH_TRUSTED_TRACE_ROOTS=/srv/zes-aoq/aoq01-e77671a/state/provider-traces
```

The repository root supplies the fixed native application port. The default is
`/srv/zes-codex/ZES-SYSTEM-BLUEPRINT`; the existing
`DEVSPACE_ZES_REPOSITORY_ROOT` is accepted as a compatibility fallback.

State defaults to `<DEVSPACE_STATE_DIR>/zes-research-cycles`. State and copied
receipts are owner-local executor evidence, not canonical ZES task or memory
state.

Provider trace files used by native `verify-admission` must resolve under the
opened workspace, the cycle-private evidence directory, or an explicitly
configured trusted trace root. Trace refs must be unique. Provider outputs are
treated as untrusted evidence until the native Research Reflex verification
accepts their exact identity.

## Model-facing tools

- `zes_research_cycle_open`
- `zes_research_cycle_prepare`
- `zes_research_cycle_assess`
- `zes_research_cycle_invalidate`
- `zes_research_cycle_verify_pre_commit`
- `zes_research_cycle_status`
- `zes_research_cycle_close`

The complete registered group is reported through the existing runtime
tool-surface fingerprint and critical capability-group assessment.

## Failure and recovery rules

- Provider failure cannot silently become `NO_SEARCH`.
- Only the native v2 admission receipt and lease can admit an action.
- A receipt is bound to task, material decision, decision boundary, source
  identity, implementation boundary, action scope, and exact admitted shell
  mutation command digests.
- A changed or missing receipt file, expired lease, changed HEAD, changed
  working-content digest, new dependency-sensitive path, or out-of-scope path
  requires reconciliation or reassessment.
- A process effect that completed but could not be recorded is indeterminate;
  inspect the workspace and cycle before retrying.
- Local lifecycle success does not authorize Git publication or runtime/effect
  execution. Use the separate continuation/publication and runtime control
  planes at effect time.

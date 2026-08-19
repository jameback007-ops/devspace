# ZES Research Reflex execution cycle

DevSpace can bind material work in a ZES checkout to the native capability-bound
ZES Research Reflex v3 admission contract. The adapter owns only executor-local lifecycle,
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
3. `zes_research_provider_invoke` optionally acquires one exact provider
   receipt and binds it to provider-execution evidence v2 inside the cycle's
   private evidence directory. The broker exposes only typed Context7, Exa, and
   targeted-Web operations. It accepts no provider endpoint, command,
   credential, or output path from the model.
4. When a material claim requires experimental rather than documentary
   evidence, `zes_research_instrument_plan` selects a bounded capability-shaped
   route without executing it. An external optional adapter may then run a
   notebook, property/stateful falsifier, disposable real-dependency test,
   treatment/control agent evaluation, trace analysis, bounded counterfactual,
   or separately authorized live canary. `zes_research_instrument_record` binds
   exact typed results and artifact digests to the current research generation;
   `zes_research_instrument_status` verifies their continued integrity. See
   [Research Instrumentation Cycle](research-instrumentation-cycle.md).
5. `zes_research_cycle_assess` invokes the fixed native
   `zes-research-reflex assess` application port. DevSpace stores and hashes the
   returned v3 receipt and lease; it does not recompute sufficiency. Every
   `research-instrument-evidence:*` ref in the native request is automatically
   verified against the current research generation and artifact digests.
   Optional `instrumentEvidenceRefs` make the intended set explicit, but cannot
   introduce a ref that is absent from the request. Historical v1/v2 receipts
   remain decodeable, but they cannot create a new admission through this action
   gate.
6. `zes_research_cycle_invalidate` reopens judgment after counterevidence,
   architecture or semantic forks, dependency/upstream changes, owner direction
   changes, repeated distinct failures, scope drift, or source-currentness
   expiry.
7. `zes_research_cycle_verify_pre_commit` re-verifies the native receipt and
   binds the complete current working-content digest, validation refs,
   currentness checks, assumptions, limitations, unresolved risks, and stopping
   reason. Instrument refs in `validationRefs` are automatically verified again
   at the commit boundary; optional `instrumentEvidenceRefs` must be a subset of
   that validation set.
8. The normal Git commit is observed. A successful commit is accepted by the
   lifecycle only when it contains the complete pre-commit-verified change set.
9. `zes_research_cycle_close` records the terminal outcome, decision delta,
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

## Evidence-provider routing

Provider selection follows the evidence need rather than whichever route is
cheapest or easiest to call:

- Context7 is the default for exact upstream library and versioned
  documentation semantics.
- Targeted Web is allowed only when the exact fact, named document, publisher,
  or official source identity is already known and only its current location or
  content needs confirmation. It performs bounded pinned-HTTPS fetches and
  explicitly records that no open-world candidate discovery occurred.
- Exa `search` is the registered operation for unknown candidate space,
  competitive alternatives, field failures, community patterns, and broad
  multi-source discovery.
- Exa `fetch` is a known-source acquisition operation. It remains useful for
  reading an already-selected URL, but it does not prove that open-world
  candidate discovery occurred merely because it uses the Exa service.
- A different provider may replace Exa search only after its exact provider
  route and open-world capability are registered and emitted by a verified
  provider receipt. Caller-selected capability labels, free text, and an
  override reason alone are insufficient.

Targeted Web, ordinary host Web Search, Context7, Exa fetch, and one
already-known source never silently substitute for unavailable Exa search on an
open-world evidence need. That boundary remains held as provider-degraded until
Exa search or a registered receipt-verified equivalent open-world provider
succeeds. Conversely, a narrow uniquely
authoritative fact does not have to spend an Exa call merely to retrieve a
known official source.

The Exa credential remains in the DevSpace service environment. The fixed
broker copies only the `EXA_API_KEY` handle into the exact Exa child process;
the model-facing result, provider receipt, logs, bind process, and arbitrary
`exec_command` environment receive neither the value nor its digest. Context7
may similarly consume an optional `CONTEXT7_API_KEY`; the public pinned CLI
route remains usable without it when the upstream permits anonymous access.
The generic command-environment passthrough also rejects both reserved names.
Provider timeouts and output ceilings terminate the complete child process
group. The fixed ZES accelerator first writes its receipt below the configured
ZES repository's private Git metadata, which is already inside the
accelerator-owned receipt allowlist and outside the worktree. DevSpace opens
that staging file no-follow, owner-checks it as a single-link private file,
imports the exact bytes once into the cycle-private evidence directory with an
exclusive write, verifies the imported digest, and removes the staging file on
every terminal path. The retained receipt/evidence files are then rebound to
the exact requested provider, operation, route ref, transport, capability
refs, open-world-performed proof, purpose, and cycle framing before admission.
Neither the model nor provider request may select a staging or receipt root.

## Configuration

```text
DEVSPACE_ZES_RESEARCH_CYCLE_MODE=observe
DEVSPACE_ZES_RESEARCH_REPOSITORY_ROOT=/srv/zes-codex/ZES-SYSTEM-BLUEPRINT
DEVSPACE_ZES_RESEARCH_STATE_ROOT=/var/lib/devspace-zesnexus/zes-research-cycles
DEVSPACE_ZES_RESEARCH_TIMEOUT_SECONDS=60
DEVSPACE_ZES_RESEARCH_TRUSTED_TRACE_ROOTS=/srv/zes-aoq/aoq01-e77671a/state/provider-traces
# Service-held provider handles used only by zes_research_provider_invoke.
EXA_API_KEY=<managed-secret>
# CONTEXT7_API_KEY=<optional-managed-secret>
```

The repository root supplies the fixed native application port. The default is
`/srv/zes-codex/ZES-SYSTEM-BLUEPRINT`; the existing
`DEVSPACE_ZES_REPOSITORY_ROOT` is accepted as a compatibility fallback.

State defaults to `<DEVSPACE_STATE_DIR>/zes-research-cycles`. State and the
byte-exact imported receipts are owner-local executor evidence, not canonical
ZES task or memory state. The temporary accelerator staging directory is
`<DEVSPACE_ZES_RESEARCH_REPOSITORY_ROOT>/.git/devspace-research-provider-receipts`;
only unique receipt files are created there, they are removed after import,
and no repository source or Git index entry is changed.

Provider trace files used by native `verify-admission` must resolve under the
opened workspace, the cycle-private evidence directory, or an explicitly
configured trusted trace root. Trace refs must be unique. Provider outputs are
treated as untrusted evidence until the native Research Reflex verification
accepts their exact identity.

## Model-facing tools

- `zes_research_cycle_open`
- `zes_research_cycle_prepare`
- `zes_research_instrument_plan`
- `zes_research_instrument_record`
- `zes_research_instrument_status`
- `zes_research_provider_invoke`
- `zes_research_cycle_assess`
- `zes_research_cycle_invalidate`
- `zes_research_cycle_verify_pre_commit`
- `zes_research_cycle_status`
- `zes_research_cycle_close`

The complete registered group is reported through the existing runtime
tool-surface fingerprint and critical capability-group assessment.

## Failure and recovery rules

- Provider failure cannot silently become `NO_SEARCH`.
- Exa search failure cannot silently downgrade an open-world decision to Exa
  fetch, targeted Web, Context7, or one known source.
- Provider credentials remain service-held handles and are never accepted as
  model input or passed to arbitrary shell execution.
- Only a new native v3 admission receipt and lease can admit an action through
  this DevSpace action gate. Historical v1/v2 receipts remain available for
  immutable decode and verification but do not create a new admission.
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

# ZES Research Instrumentation Cycle

The Research Reflex provider routes answer questions that are primarily about
external facts, upstream semantics, and the open-world candidate space. Some
material AOQ claims cannot be resolved by reading more sources. They require a
computational model, an attempt to falsify an invariant, a real dependency, an
actual agent trajectory, a treatment/control comparison, or a bounded live
canary.

The Research Instrumentation Cycle adds an executor-local protocol for those
claims. It does not make Jupyter, Hypothesis, Testcontainers, Inspect AI,
Phoenix, OpenTelemetry, or any other experiment framework a required DevSpace
dependency. It selects a capability-shaped experimental route, then binds the
artifacts produced by an independently executed adapter to the current Research
Reflex generation. A separately configured ZES-specific edge may execute one
already-planned Inspect AI step through the fixed shared Research Lab; the core
planner and receipt binder remain provider-neutral.

## Authority boundary

The instrumentation layer owns only:

- deriving an experimental evidence need from a declared claim class;
- recording a bounded plan before the experiment is executed;
- identifying missing sandbox, model, or live-effect boundaries;
- validating typed result shape and treatment/control separation;
- reading exact bounded artifact files and binding their byte count and SHA-256;
- verifying that the receipt still belongs to the current research generation;
- detecting changed, missing, linked, oversized, or out-of-root artifacts; and
- exposing evidence refs and claim ceilings to the existing Research Reflex
  assessment and pre-commit lifecycle.

When the optional shared-Lab edge is enabled, the instrumentation layer may
also:

- dispatch one exact unblocked current-generation Inspect AI plan step;
- accept only a named `experiments/*.py@task_name` entry and shared evaluator
  profile under a fixed server-owned Lab root;
- persist dispatch, running, terminal, and indeterminate state before allowing
  any retry;
- copy exact terminal runner receipts and Inspect traces into cycle-private
  evidence; and
- return the original state or terminal receipt for every replay of the same
  idempotency key.

It does not:

- expose an arbitrary notebook, property-test, container, shell, executable,
  path, endpoint, credential, model, reasoning, protocol, fallback, or canary
  execution surface;
- decide whether a claim is true;
- decide whether research is sufficient;
- turn a model self-report into independent evidence;
- grant task, semantic, writer, publication, release, activation, runtime, or
  effect authority; or
- create another AOQ experiment, evaluation, memory, or workflow source of
  truth.

The shared Lab is below the harness boundary. ChatGPT/Sol Pro may use the
optional Nexus execution edge, while Codex retains its native harness and may
use the same Lab through a Codex-native skill. Neither lane owns or rewrites the
other lane's planning, continuation, checkpoint, or orchestration lifecycle.

The native ZES Research Reflex remains the decision-admission and sufficiency
authority. Publication and runtime effects remain separately governed.

## Lifecycle

The intended model-facing flow is:

1. Open and prepare the normal Research Reflex cycle against a clean Git
   baseline.
2. Acquire documentary evidence through Context7, Exa, targeted Web, local
   authority, or a valid prior episode when those routes can change the
   decision.
3. Call `zes_research_instrument_plan` for any remaining material claim that
   requires experimental evidence.
4. Execute the selected adapter under the declared boundary. A compatible
   Inspect AI `agent_behavior_eval` or `bounded_counterfactual` step may use
   `zes_research_instrument_execute` when the fixed shared-Lab edge is enabled;
   every other adapter remains independently executed:
   - `local_only` for deterministic local computation or property testing;
   - `isolated_sandbox` for disposable dependencies or agent evaluation; or
   - `bounded_live` only after separate runtime/effect authorization.
5. Persist the executable inputs, result, traces, minimized counterexample,
   report, or canary receipt under the workspace or the cycle-private evidence
   directory. The optional Inspect edge materializes its terminal runner result,
   traces, log, and execution manifest under `lab-executions/` in cycle evidence.
6. Call `zes_research_instrument_record` with the typed result and exact
   artifacts. DevSpace binds their byte identities but does not reinterpret the
   experiment.
7. Reference the emitted `research-instrument-evidence:*` identity inside the
   native Research Reflex request. DevSpace automatically discovers and verifies
   every such ref before native assessment. `instrumentEvidenceRefs` may be
   supplied to make the intended set explicit, but every supplied ref must also
   appear in the native request.
8. Before commit, include the same current evidence refs in `validationRefs`.
   DevSpace automatically discovers and verifies instrument refs in that set.
   Optional `instrumentEvidenceRefs` must be a subset of `validationRefs`.
   Artifact integrity and research generation are rechecked before the native
   pre-commit challenge proceeds.
9. Close the normal research episode with its decision delta, limitations,
   reusable findings, reversal conditions, and stopping reason.

An instrument plan is invalid for a later Research Reflex generation. A new
generation must create a new plan and receipt rather than silently inheriting
old experimental evidence.

## Evidence-route matrix

| Claim or evidence need | Instrument capability | Typical optional adapters | Maximum default claim |
| --- | --- | --- | --- |
| Parameter sensitivity, distributions, simulation, capacity model | `notebook_experiment` | Jupyter, Papermill, nbclient | Bounded computational observation |
| Protocol invariant, state-machine safety, malformed input space | `property_falsification` | Hypothesis, QuickCheck-compatible runner | No counterexample in the bounded search, or one minimized counterexample |
| Database, queue, vector store, browser, or runtime interoperability | `real_dependency_integration` | Testcontainers, disposable Docker Compose | Tested versions and scenarios only |
| Whether an actual agent behaves better under a treatment | `agent_behavior_eval` | Inspect AI, provider-neutral agent eval harness | Sampled treatment/control agent behavior only |
| Why a run acted differently and which context/tool path was observed | `trace_analysis` | OpenTelemetry, Phoenix, Inspect eval logs | Observed trajectory and attribution only |
| Whether an intervention caused a bounded behavior delta | `bounded_counterfactual` | randomized or matched treatment/control harness plus statistical analysis | Bounded counterfactual support only |
| Whether a deployed path survives real operational conditions | `live_canary` | bounded deployment or fault-injection canary | Bounded live runtime observation only |

The matrix is not a tool quota. An architecture trade-off may need only strong
documentary evidence. Conversely, an agent-utility or causal-reliance claim
cannot be established by another Web search, a prompt assertion, or a passing
unit test.

## Claim classes and default derivation

`zes_research_instrument_plan` accepts one claim class:

- `architecture_tradeoff` derives no experiment by default. Add an explicit
  evidence need only when an empirical claim remains.
- `protocol_invariant` derives state-space falsification.
- `dependency_interoperability` derives real-dependency integration.
- `performance_or_capacity` derives computational modeling and real-dependency
  behavior.
- `agent_behavior_or_utility` derives treatment/control agent evaluation plus
  trace attribution.
- `causal_reliance` derives bounded counterfactual evidence plus trace
  attribution.
- `operational_resilience` derives state-space falsification plus a bounded live
  canary.
- `local_mechanical` derives no experimental step.

The caller may add explicit evidence needs, but cannot lower the boundary
required by a derived step. For example, an agent evaluation is held when model
execution is forbidden or only local execution is allowed. A live canary is
held unless the declared boundary is `bounded_live`; the plan still grants no
effect authority.

## Artifact and receipt rules

Each receipt binds between one and twenty existing files. Files must be regular,
single-link files under either the exact workspace root or the cycle-private
evidence root. Absolute paths, traversal, symlinks, hard links, oversized files,
and references to the instrumentation state itself are rejected.

Receipt replay is idempotent only while:

- the idempotency input is identical;
- the Research Reflex cycle and generation are identical; and
- every artifact still has the recorded SHA-256 and byte count.

A changed result file cannot be silently accepted under the prior evidence ref.
The experiment must be recorded as a new receipt with a new idempotency key.

## Typed result constraints

The protocol applies hard-negative checks before a receipt is retained:

- a found property counterexample requires a counterexample artifact and cannot
  be recorded as passed;
- a failed property result without a counterexample must be recorded as
  indeterminate rather than as a disproved invariant;
- a passed real-dependency result requires every declared scenario to pass;
- agent and counterfactual treatment/control identities must differ;
- agent evaluation requires exact agent target, model, dataset, scorer, trace,
  sample, replicate, and seed identities;
- causal evidence requires assignment, intervention, treatment, control,
  analysis, outcome, and behavior-delta lineage; and
- a passed live canary requires terminal outcome observation plus exact runtime,
  effect, and cleanup identities.

These checks validate evidence shape and provenance. They do not grade the
quality of the scorer, dataset, experiment design, or statistical conclusion.
That judgment remains inside the Research Reflex assessment and later outcome
evaluation.

## API keys and model execution

Most instrument kinds do not inherently require an LLM or a provider API key.
Property testing, disposable dependency integration, deterministic notebook
execution, and trace analysis can run without model access. Agent evaluation
and agent-specific counterfactuals require an exact model or provider session;
the receipt records model refs but never accepts credentials.

Provider subscription, API entitlement, and model execution remain adapter
concerns. DevSpace does not infer that a WebChat subscription grants API usage,
does not proxy arbitrary credentials into experiment commands, and does not
claim model-backed evidence when `modelUse` is `forbidden`.

The optional Inspect edge receives no provider credential from the model. It
starts the fixed shared-Lab runner with a minimal environment; that runner may
use its own root-owned local 9Router binding. Shared evaluator model, reasoning,
protocol, and escalation policy remain Lab configuration rather than DevSpace
task or semantic authority.

## Example: memory reliance

For a claim that admitted memory improves real tool use:

1. Documentary research identifies active-use, attribution, interference, and
   counterfactual evaluation patterns.
2. `agent_behavior_or_utility` creates an agent treatment/control step and a
   trace-attribution step.
3. The same task set, agent surface, model snapshot, scorer set, and seeds run
   under `memory_on` and `memory_off` conditions in an isolated sandbox.
4. The receipt binds exact trajectories, task outcomes, model refs, treatment,
   control, sample count, replicate count, and limitations.
5. A stronger `causal_reliance` claim additionally requires an intervention and
   bounded counterfactual lineage. Memory exposure or a model statement that it
   used memory remains below that claim ceiling.

This separates three different statements:

- the memory/context code satisfies deterministic invariants;
- the real storage and retrieval substrate interoperates; and
- representative agents actually benefit without unacceptable negative
  transfer.

## Current implementation boundary

The current slice supplies the provider-neutral planner, receipt binder,
artifact-integrity verification, MCP tools, Research Reflex assessment seam,
and pre-commit seam. It also supplies one opt-in, asynchronous, idempotent
Inspect AI execution edge for the fixed shared ZES Research Lab. The edge is
limited to isolated-sandbox model-backed plan steps, has bounded concurrency,
does not perform live canaries, never automatically escalates a profile or
falls back to another protocol, and blocks new dispatch for an exact plan step
while an earlier outcome is indeterminate.

Other adapter-specific runners, representative datasets, scorer qualification,
longitudinal Task N→N+k experiments, and bounded live canaries remain separate
evidence-producing effects. Source support does not itself mean that a Nexus
runtime has enabled, deployed, or exercised the optional edge.

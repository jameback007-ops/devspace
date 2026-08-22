# Incumbent DevSpace characterization protocol

LangGraph, Deep Agents, Agent Server, and LangSmith are the owner-committed
long-term ZES direction. This protocol does not select a platform and cannot
veto that direction. DevSpace is an incumbent evidence source used to identify
what can be replaced natively, retired, rejected, or—only after a concrete
native gap is falsified—retained as the smallest thin binding.

The characterization is split into two evidence classes so deterministic
replay is not misreported as model-quality evidence.

## C0 — deterministic capability replay

Use `scripts/prepare_ab_workload.py` to create two Git clones from one exact
baseline commit. Replay the same bounded operation sequence and exact repair in
both lanes:

```text
open workspace and native context
→ read tests and both owning modules
→ run failing tests
→ change discount threshold semantics
→ change tax calculation order
→ run full tests
→ git diff --check and inspect diff
→ record/read durable state
```

This phase may compare:

- terminal tool success and failure;
- tool-call count and measured tool latency;
- test and validation outcome;
- changed-file set, diff size, and patch equivalence;
- checkpoint/state and trace/audit availability;
- connector or schema failures;
- operational ceremony.

It may **not** compare reasoning quality, diagnosis quality, or token economy,
because one WebChat session knows the expected repair and can transfer context
between lanes.

C0 interpretation is subtractive. A DevSpace capability is not an adoption
candidate merely because it exists or performs well. Before any custom work it
must satisfy all of these conditions:

1. durable and generalizable across ZES rather than WebChat-only;
2. clear long-term runtime or product value;
3. not already covered acceptably by LangGraph, Deep Agents, Agent Server,
   LangSmith, A2A, MCP, or another mature replaceable component;
4. compatible with the intended authority boundary rather than recreating a
   pseudo-runtime or control-plane database;
5. supported by a measured gap or repeated operational need;
6. implementable as the smallest thin binding.

The default disposition is **REJECT**, **RETIRE**, or **DEFER**, not PORT. C0
does not authorize expansion of the frozen 24-tool MCP core.

## C1 — optional independent behavioral characterization

Use fresh WebChat chats with no shared conversation context. For each paired
task:

1. create two clones from one exact baseline commit;
2. randomly assign DevSpace or native bridge to the first fresh chat;
3. give both chats the same mission text and no solution hints;
4. prohibit specialists and second-model delegation for the primary repair;
5. preserve explicit execution-scope/workstream refs;
6. score only after both chats are terminal;
7. counterbalance lane order across at least four paired tasks.

Behavioral metrics may include correctness, unnecessary edits, diagnosis/tool
trajectory, elapsed wall time, tool-call count, context/skill selection,
validation completeness, recovery behavior, and user ceremony. A single pair
is a pilot. Even a multi-task C1 characterizes harness behavior; it does not
decide the ZES platform direction.

## Fixture

`fixtures/coding-ab-billing` is intentionally multi-file and instruction-aware:

- root and nested `AGENTS.md` files;
- one progressive-disclosure skill;
- a boundary defect in `discounts.py`;
- a calculation-order defect in `invoice.py`;
- two failing and two passing tests at baseline;
- exactly two expected changed source files.

Prepare and score:

```bash
ROOT=/tmp/chatgpt-langchain-ab-gate-c
uv run python scripts/prepare_ab_workload.py --output-root "$ROOT"

# Run each lane through its actual MCP host, then:
uv run python scripts/score_ab_workload.py \
  --devspace "$ROOT/devspace" \
  --native "$ROOT/native"
```

The scorer verifies tests, `git diff --check`, the exact changed-file set, and
patch equivalence. It sets `PYTHONDONTWRITEBYTECODE=1` so observation does not
create `__pycache__` state inside measured clones. Transport metrics remain
sourced from DevSpace audit and LangSmith Threads rather than a new benchmark
telemetry store.

The fixture uses the Python standard-library `unittest` runner so both lanes
execute the same tests without installing a benchmark-specific dependency:

```bash
python3 -m unittest discover -s tests -v
```

## C0 result — 2026-08-22

Both lanes started from the same clean commit, reproduced two failures, passed
all four tests after repair, changed exactly the two owning source files, passed
`git diff --check`, and produced the same patch digest.

The useful result is not a winner:

- native Deep Agents and Agent Server already cover the coding, context,
  workstream, state, and observability surfaces needed by this workload;
- DevSpace's one-call multi-file patch is an ergonomic observation, but one C0
  sample does not justify another core tool;
- LangSmith exposed additional host/server invocations beyond visible model
  calls. This is a measurement target, not evidence for cloning DevSpace's
  activity database;
- DevSpace recovery and execution-scope machinery was not exercised and cannot
  be ported by inference.

See `evidence/gate-c0-harness-characterization-20260822.json`.

# DevSpace versus native bridge A/B protocol

Gate C is split into two evidence classes so a deterministic replay is not
misreported as a model-quality comparison.

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

## C1 — independent behavioral A/B

Use fresh WebChat chats with no shared conversation context. For each paired
task:

1. create two clones from one exact baseline commit;
2. randomly assign DevSpace or native bridge to the first fresh chat;
3. give both chats the same mission text and no solution hints;
4. prohibit specialists and second-model delegation for the primary repair;
5. preserve explicit execution-scope/workstream refs;
6. score only after both chats are terminal;
7. counterbalance lane order across at least four paired tasks.

Behavioral metrics include correctness, unnecessary edits, diagnosis/tool
trajectory, elapsed wall time, tool-call count, context/skill selection,
validation completeness, recovery behavior, and user ceremony. A single pair
is a pilot, not a migration decision.

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
patch equivalence. Transport metrics remain sourced from DevSpace audit and
LangSmith Threads rather than a new benchmark telemetry store.

The fixture uses the Python standard-library `unittest` runner so both lanes
execute the same tests without installing a benchmark-specific dependency:

```bash
python3 -m unittest discover -s tests -v
```

---
name: operator-observability
description: Use for operator tracing, Phoenix queries, Codex OTel, ChatGPT-through-Nexus audit, or diagnosing repeated work and outcome/telemetry mismatches. This is not Product-wide observability authority.
x-devspace:
  exposure: contextual
  workspace-markers:
    - docs/operator-observability.md
---

# Operator observability

Read `docs/operator-observability.md` for current source/operated boundaries and
the native clients. Query retained observations before launching another model
experiment. Use Phoenix CLI/MCP/SDK for spans, sessions, annotations, datasets and
experiments; do not reconstruct raw Codex rollouts or build a duplicate dashboard.

The optional Nexus exporter records MCP tool activity, process identities, safe
lengths/digests and native outcome metadata. It does not observe ChatGPT's hidden
reasoning, model tokens, built-in tools or pre-handler host refusals. Keep unknowns
visible and distinguish missing coverage from no work.

Codex native logs, trace events and metrics are separate signals. Do not add their
copies together as independent calls or silently discard unattributed usage.
Tool transport success does not establish command success, expected test outcome,
task acceptance or later benefit. Use actual trace/turn/call identities, not only
timestamps or process-local sequence numbers.

Count only evidenced invocations: structural Codex spans are not tool calls and
native nested tool-result events are not independent user commands. OTLP retries
may deliver the same trace/span twice. Use the query's duplicate/conflict and
invalid-measurement fields; do not silently choose a favorable conflicting copy.
Collector HTTP acceptance, crash-surviving queue admission, downstream delivery
and Phoenix query visibility are different boundaries. See the retained native
fault cases in `docs/operator-durability-20260908.md` before claiming durability.

Start with one consequential question: repeated path reads, excessive returned
volume, a slow call, a false success claim, or a receiver not using a deployed
capability. Inspect examples and source; make a candidate correction; use native
annotations/experiments to compare outcomes. Report evidence and limitations,
not an automatic score of agent quality.

Before enabling real producers, verify the receiver's actual private/authenticated
boundary and retained-data policy. Example service files do not establish deployed
network protection. Keep active worker sessions intact. A source-only change or
synthetic canary is not ongoing Codex/ChatGPT trace coverage.

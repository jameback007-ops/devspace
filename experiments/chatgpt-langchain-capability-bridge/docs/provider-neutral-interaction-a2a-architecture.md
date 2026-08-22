# Provider-neutral interaction and A2A architecture

## Decision

ZES should not build A2A around the current AOQ role roster, one model family,
or one agent runtime. The stable product boundary is an actor-neutral
interaction substrate. Current roles, leadership policy, work topology, and
runtime placement remain replaceable composition above or beside that
substrate.

```text
                    ZES interaction core
       participant / endpoint / capability / context
       interaction / correlation / message / task
       artifact / receipt / delivery / trace / authority refs
                              │
              ┌───────────────┼────────────────┐
              │               │                │
         A2A adapter     internal adapter   WebChat adapter
        cross-runtime     same runtime      constrained edge
              │               │                │
       external peers    LangGraph/other    MCP + durable pull
```

The core contains no `Lead`, `Research`, `Verifier`, parent/child tree, fixed
agent count, provider model, or workflow graph. A future coordination policy
may route by dynamic capability, role, topology, cost, evidence, or authority
without changing the interaction primitives.

## Native-first decision ladder

Native-first is an evidence order, not a ban on adapters or design judgment:

1. Use an upstream implementation when it owns the exact capability.
2. Compose multiple mature implementations when no one stack owns the full
   boundary.
3. Reuse an established architecture or protocol pattern when the reusable
   asset is a mechanism rather than a software package.
4. Add a bounded adapter for representation, authority, lifecycle, or host
   constraints that upstream cannot know.
5. Create a new local mechanism only after the preceding options have a typed
   gap and falsifier.

This candidate therefore composes:

- A2A 1.0 for cross-runtime discovery, messages, tasks, artifacts, streaming,
  and cancellation;
- LangGraph Agent Server Threads, Runs, Store, native A2A routes, and Agent
  Cards for durable runtime interaction;
- LangSmith and OpenTelemetry-compatible context for tracing;
- the MCP bridge only as the WebChat edge projection;
- ZES authority contracts outside communication.

The custom code is limited to neutral references, endpoint allowlisting,
adapter selection, safe protocol compatibility, WebChat durable-pull delivery,
and explicit authority separation.

## Stable core

The stable core is deliberately smaller than either the A2A or LangGraph data
model:

```text
ParticipantRef
EndpointRef
CapabilityRef

InteractionRef
InteractionContextRef
CorrelationRef

Message / Request / Response
TaskRef / TaskState / Cancellation
ArtifactRef
DeliveryReceipt / DeliveryState

SchemaRef
TraceContext
AuthorityRef[]
```

Payload meaning is selected by `kind` plus `schema_ref`. Product-specific
semantics such as research requests, code review, incident response, leadership
joins, or release decisions are schemas and coordination policy above the core,
not hard-coded interaction enums.

## Adapter boundary

`EndpointDescriptor` contains only neutral endpoint identity, participant,
transport selection, capability advertisements, and opaque adapter config.
Transport-specific fields are interpreted by a registered adapter.

```text
EndpointDescriptor
  endpoint_ref
  participant_ref
  transport
  capability_refs
  adapter_config

InteractionAdapter
  discover
  send
  get_task
  cancel_task
```

The initial registered adapter is `a2a`, implemented with the official Python
SDK. A future internal LangGraph, local model, Codex, Hermes, or deterministic
service adapter can be added behind the same core without inserting its native
IDs into the stable product ontology.

For agents already inside one LangGraph or Deep Agents runtime, native
subagent/task/run calls remain the preferred local path. A2A is the
interoperability boundary for different runtimes, harnesses, organizations, or
opaque peers; it is not a mandatory hop for every internal call.

## WebChat-specific edge

WebChat is a constrained interactive edge peer, not a standing A2A runtime:

- outbound collaboration uses the registered interaction adapter directly;
- inbound A2A enters a native Agent Server interaction thread;
- the interaction graph writes a bounded projection to Agent Server Store;
- `workspace_open` returns only pending metadata summaries;
- `interaction(action="inbox")` pulls bounded detail;
- `interaction(action="ack")` advances only WebChat delivery state;
- no authoritative online, thinking, idle, or hung presence is claimed;
- peer execution and delivery survive a missing WebChat turn.

Each WebChat workstream resolves two native Agent Server threads:

```text
runtime thread       bridge_journal
interaction thread   bridge_interaction / native A2A context
```

The previous v2 runtime thread is migrated in place by adding role metadata;
the interaction thread is additive. This avoids converting one thread into a
universal identity with mixed execution and communication semantics.

## Authority boundary

Communication is not authorization:

```text
A2A Message or Task
        != ZES WorkItem
        != AssignmentLease
        != WorkspaceLease
        != ExecutionLease
        != effect or publication authority

LangGraph Run
        != universal task identity
```

Interaction metadata may carry `authority_refs`, but those are references for a
downstream admission check. The interaction adapter cannot grant, widen,
activate, transfer, or infer authority. Material workspace mutation still
requires the rightful ZES workspace/assignment/effect boundary.

## Delivery projection

A2A and Agent Server remain owners of protocol task/message/run state. The only
additional persisted value is the WebChat delivery projection needed because a
ChatGPT turn cannot receive arbitrary server push:

```text
interaction_ref
scope_ref / workstream_ref
direction / kind / observed state
native endpoint / context / task / message refs
artifact refs
delivery state: unseen | seen | acknowledged
bounded summary / schema / trace / authority refs
```

It is stored in Agent Server Store under the bridge namespace. It is not a
message database, transcript, task engine, run state machine, or canonical
conversation memory. Raw endpoint locations are not exposed by the MCP
manifest, and model callers select only configured endpoint aliases.

## A2A compatibility finding

The qualification environment used:

- `a2a-sdk==1.1.2`;
- LangGraph API `0.13.0`;
- the native Agent Server A2A endpoint and Agent Card;
- the official SDK transport implementation.

The Agent Server card advertised lower-case `jsonrpc`, while the SDK transport
registry expected the `JSONRPC` label. The server also emitted the older
kind-tagged JSON-RPC representation despite a v1 card, which the strict v1
protobuf parser rejected. The official SDK already ships a v0.3 compatibility
transport, so the adapter uses two explicit modes:

- `strict-v1` — default for conforming peers;
- `legacy-v0.3` — opt-in only for a specifically qualified endpoint.

The bridge normalizes the binding label and selects the SDK compatibility
transport. It does not implement A2A JSON-RPC itself. The compatibility choice
is endpoint configuration, not a downgrade of the neutral interaction core.

## Qualification ceiling

The isolated qualification proved:

- 25-tool v3 MCP discovery with one grouped `interaction` tool;
- Agent Card discovery through the official SDK;
- MCP → official A2A client → native Agent Server A2A endpoint;
- a native task with four streamed events;
- inbound projection to the exact interaction thread;
- preservation of workstream, context, peer, schema, trace, and authority refs;
- durable-pull inbox and acknowledgement;
- no role/topology assumption and no material-authority transfer.

It does not yet prove:

- a second independent remote A2A implementation;
- production authentication and authorization between peers;
- push-notification delivery across restarts;
- large artifact transfer policy;
- a production internal-runtime adapter;
- role-specific coordination, joins, or leadership behavior.

Those are later adapter, deployment, and coordination qualifications. They do
not require changing the neutral core.

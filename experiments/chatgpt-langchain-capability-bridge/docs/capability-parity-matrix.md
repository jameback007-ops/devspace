# Native qualification and incumbent extraction matrix

LangGraph, Deep Agents, Agent Server, and LangSmith are the committed long-term
ZES direction. This matrix separates native capability qualification from
WebChat model-loop boundaries and uses DevSpace only as an incumbent source for
subtractive capability extraction. It is not a platform-selection scorecard.

| Capability | Native basis | Qualification state | Remaining proof |
|---|---|---:|---|
| Workspace selection | Thin allowed-root registry + workstream identity | Passed locally and direct WebChat | Multi-repo production workload |
| File list/read/write/edit/delete | Deep Agents backend protocol | Passed direct WebChat | Representative multi-file repair |
| Search/glob | Deep Agents backend protocol | Passed | Representative multi-file diagnosis |
| Shell/build/test/Git | Deep Agents `execute` | Passed in isolated container | Representative project workload |
| Binary artifact transfer | Native `upload_files` / `download_files` | Passed with checksum | Direct WebChat binary round trip |
| Skills | Native `SkillsMiddleware` metadata loading | Passed | WebChat selects and reads the correct skill |
| `AGENTS.md` memory | Native `MemoryMiddleware` ordered sources | Passed | Nested project-instruction behavior |
| Context progressive disclosure | Thin explicit MCP projection | Passed | Long task token/quality comparison |
| Durable checkpoint | LangGraph SQLite / Agent Server Store | Passed direct record/read | Resume from new WebChat chat |
| Agent Server threads/history/state | `langgraph_sdk.threads` | Passed on live v2 custom route | Production deployment persistence |
| WebChat workstream binding | `threads.search/create` + LangSmith `thread_id` metadata | Passed: one native runtime thread and one LangSmith Thread | Long-horizon reconnect identity |
| Native structured planning | `TodoListMiddleware.WriteTodosInput` + thread state | Passed unit and live v2 round trip | WebChat behavior on a long task |
| Agent Server durable runs/events/cancel | `langgraph_sdk.runs` | Passed on live v2 custom route | Production queue/load behavior |
| Native HITL interrupt/resume | LangGraph `interrupt` + Agent Server `Command(resume)` | Passed on live deterministic graph | Real specialist approval flow |
| Agent Server Store | Native Store with bridge namespace prefix | Adapter passed; prior Store probe passed | Cross-chat state readback |
| Optional specialist agents | Allowlisted Agent Server assistants | Adapter passed; disabled by default | Real specialist usefulness and cost |
| Local isolation | Read-only Docker + private network | Passed baseline | Penetration/negative mount checks |
| Native sandbox provider port | `NativeSandboxProvider` + Deep Agents backend | Passed structurally | Select live provider |
| LangSmith Sandbox | Native SDK + `LangSmithSandbox` | **Blocked: organization feature disabled** | Enable feature or select another provider |
| Persistent PTY / stdin / kill / reconnect | Provider-native command handle | Adapter passed with native contract fake | Live provider qualification |
| Tool observability | LangSmith `trace` + native Threads | Passed live and in C0 characterization | Multi-workload trace characterization |
| Observability UI | LangSmith Studio / Deployment Threads tab | Native surface available; no custom dashboard | Production deployment exposure |
| Tool catalog identity | Versioned 24-tool v2 qualification snapshot | Descriptor test ready | ChatGPT scan/reconnect stress |
| Private transport | OpenAI Secure MCP Tunnel | Passed direct discovery/read/write/execute/checkpoint | Long-run reconnect stress |
| Stable route substitution | Same versioned MCP descriptor snapshot over standalone bridge or Agent Server custom route | Passed without ChatGPT app rescan | Production deployment failover |
| Tunnel reconnect continuity | Explicit workstream + native thread/store/trace identities | Passed one restart with one immediate host transient before native trace | Repeated and long-horizon restart sample |
| Provider-neutral interaction core | Participant/endpoint/capability/context/task/artifact/receipt refs | Passed unit and isolated native A2A qualification | Production internal-runtime adapter |
| External peer interoperability | Official A2A SDK + Agent Server native A2A/Agent Card | Passed one self-contained SDK-to-Agent-Server route | Independent remote peer and auth |
| WebChat inbound collaboration | Native interaction thread + Agent Server Store durable-pull projection | Passed inbox/ack qualification | Restart and push-notification continuity |
| Interaction authority isolation | ZES authority refs are carried but never granted by communication | Passed schema, negative tests, and native route | Production policy/admission integration |
| Candidate tool catalog identity | Versioned 25-tool v3 qualification snapshot; count is not a product freeze | Descriptor and MCP route qualified | Explicit ChatGPT app rescan/deployment |
| Tool-surface evolution | Promote frequent/high-value stable capabilities; group or defer immature/rare ones | Policy defined | Usage evidence after broader operation |
| A2A workflow maturity | Neutral transport/substrate only; role schemas, join policy, and choreography deferred | Bounded interoperability qualified | Stable agent-role and product-schema contracts |
| Hidden WebChat reasoning checkpoint | No public seam | Not claimable | Remains a WebChat/platform property |
| Hidden WebChat system prompt replacement | No public seam | Not possible through MCP | Use server instructions/skills/context instead |
| Automatic WebChat history summarization | Deep Agents model-loop middleware | Not applicable to WebChat loop | Compare WebChat continuity empirically |

## Qualification and extraction stages

### Gate A — direct WebChat coding over Secure MCP Tunnel

ChatGPT must repair a failing disposable repository itself through the v2 MCP
surface. No second model or specialist may perform the repair.

Pass criteria:

- Tunnel and private bridge remain ready throughout discovery and calls.
- ChatGPT sees 24 tools and the exact v2 descriptor fingerprint.
- ChatGPT opens the repository, discovers relevant instructions, diagnoses the
  failure, edits the source, validates tests and diff, and records a checkpoint.
- Every mutation returns a terminal structured result and is immediately
  confirmed by source readback or an equivalent authoritative state read.
- The direct app namespace remains callable for the complete repair sequence;
  a mid-turn resource disappearance is a Gate A failure even when tunnel
  health remains ready.
- The private bridge has no public listener.
- The direct path does not use Legacy/Nexus as a relay.

Observed result:

- the first generic `ZES` app namespace exposed a host resource-continuity
  failure after one non-terminal edit attempt;
- bridge and tunnel stayed healthy, and an identical local MCP edit passed;
- renaming and reconnecting the app as `ZES_LangChain_Runtime` restored a
  unique host namespace without recreating the tunnel or credentials;
- ChatGPT then opened the repository, read the native instructions and skill,
  reproduced two failures, applied one exact edit, confirmed readback, passed
  `2 passed`, passed `git diff --check`, and recorded/read a checkpoint;
- the repair used the direct app only—no Nexus, Legacy, specialist, or second
  model performed the code change.

Status: **Gate A passed after unique app namespace reconnect.** See
`evidence/direct-webchat-host-boundary-20260822.json`.

### Gate B — full native context/runtime qualification

Use one representative task to exercise:

- skills and nested `AGENTS.md` discovery;
- artifact transfer;
- Agent Server thread/run/history/Store;
- one WebChat workstream ref resolved to exactly one Agent Server thread;
- the same workstream ref grouping MCP traces into one LangSmith Thread;
- native todos in thread state;
- native interrupt observation and `Command(resume)` continuation;
- provider-neutral peer discovery/message/task/artifact semantics;
- one native interaction thread distinct from the runtime thread;
- WebChat durable-pull pending projection and acknowledgement;
- explicit specialist invocation only where justified;
- LangSmith traces without payload values.

Persistent PTY is a subgate, not a blocker for Gate A. It remains held until a
live native sandbox provider is available.

Native workstream observability is now passed in the development Agent Server:
thread status/updated time come from Agent Server, tool trajectory comes from
LangSmith Threads, and inspection uses LangSmith Studio. No execution-scope
database, trace store, dashboard, or custom run state machine was added. See
`evidence/native-workstream-observability-20260822.json`.

The live Secure MCP Tunnel was then switched from standalone `/mcp` to Agent
Server `/coding/mcp` while the `ZES_LangChain_Runtime` app stayed connected and
the ABI remained identical. Direct ChatGPT calls created one native Agent
Server thread, produced one LangSmith Thread with five traces, and stored the
checkpoint in Agent Server Store. See
`evidence/direct-native-agent-server-route-20260822.json`.

One controlled tunnel-client-only restart then preserved the same app
namespace, explicit workstream ref, native Agent Server thread, Agent Server
Store checkpoint, and LangSmith Thread without a rescan. The first direct call
made immediately after tunnel readiness failed above the native trace boundary;
later direct calls succeeded and appended to the existing LangSmith Thread.
Gate D therefore passes identity and recovery continuity for one restart, but
does not prove zero-gap availability. See
`evidence/direct-tunnel-reconnect-continuity-20260822.json`.

### Gate C — incumbent characterization and capability extraction

Run the same bounded task against identical repository clones:

- DevSpace baseline;
- ChatGPT + native LangChain capability plane.

Characterize:

- task correctness and test outcome;
- elapsed time and tool-call count;
- schema/transport/tool failures;
- diff quality and validation completeness;
- recovery after interrupted commands or connector loss;
- context/skill selection quality;
- ceremony and custom infrastructure required.

Gate C has no platform-selection or veto authority. C0 runs deterministic
capability replay on identical clones; optional C1 uses counterbalanced fresh
WebChat chats only for behavioral characterization. The same session may
establish tool/transport behavior but cannot fairly establish model reasoning
quality after learning the repair.

C0 now passes on the multi-file billing fixture:

- both lanes passed all four tests and `git diff --check`;
- both changed exactly the same two source files;
- both produced patch digest
  `749a135c48de4db325545c6d02fdf421371d3bc225ac05ee2724a1f0ae58f8d9`;
- DevSpace used 12 visible calls including one multi-file `apply_patch`;
- the native lane used 13 visible calls, while LangSmith observed 29 root
  traces with zero errors. Project-wide correlation found 31 unique tunnel
  `tools/call` commands and 31 LangSmith root traces in the same window. The 16
  additional C0 calls were host-issued read/context/open/status calls; edits
  and executions were not duplicated;
- no behavioral, reasoning-quality, or elapsed-time superiority claim is valid
  because the same session ran DevSpace first.

Extraction uses a strict default of REJECT/RETIRE/DEFER. C0 supports native
Deep Agents coding and context, Agent Server workstream/state, and LangSmith
observability; it does not by itself justify a particular tool-surface addition
or cloning DevSpace execution-scope and recovery machinery. Separate repeated
usage and quality evidence can justify first-class tools. See
`docs/ab-benchmark-protocol.md` and
`evidence/gate-c0-harness-characterization-20260822.json`. The call-boundary
diagnosis is in
`evidence/gate-c0-call-amplification-diagnosis-20260822.json` and supports a
REJECT disposition for a custom dedup or activity-store clone.

C0 did not authorize the later v3 interaction addition. That addition is an
independent owner-directed product requirement and passed its own native-first
qualification. It adds one grouped interaction tool rather than importing a
DevSpace control plane. See
`docs/provider-neutral-interaction-a2a-architecture.md` and
`evidence/native-a2a-interoperability-qualification-20260823.json`.

### Gate D — continuity and catalog failure

After a durable checkpoint:

1. disconnect or restart the tunnel sidecar;
2. issue a bounded read-only sentinel after tunnel readiness;
3. reconnect the draft ChatGPT app only if the namespace does not recover;
4. open a new chat;
5. recover from repository state plus LangGraph/Agent Server state;
6. verify the tool count and fingerprint remain exact.

This gate distinguishes transport stability from ChatGPT host catalog caching.
One same-chat tunnel restart now passes without app rescan, with one immediate
host-side transient before native tracing. New-chat and repeated long-horizon
samples remain open.

### Gate E — production boundary

Require:

- dedicated Agent Server/bridge runtime;
- native Postgres and Redis backing services required by standalone Agent
  Server rather than custom persistence;
- the required standalone Agent Server license authority;
- private Secure MCP Tunnel transport;
- sandbox provider or equivalent strong isolation for untrusted execution;
- explicit assistant and Store namespace allowlists;
- durable state and bounded retention;
- observability with no credentials, source payloads, or hidden reasoning;
- idempotent deployment and rollback.

The production direction is the licensed standalone Agent Server, not managed
Deployment and not a custom persistence clone. Current readiness inventory:

- production image/config: ready;
- `LANGGRAPH_CLOUD_LICENSE_KEY`: absent;
- managed Deployment API with current key: `403 Forbidden`;
- dedicated Postgres/Redis: inactive;
- lifecycle independent from DevSpace: absent;
- capacity window: held because disk is 81 percent, swap is exhausted, and a
  concurrent DIND workload is using substantial memory and CPU;
- secret and network binding: specified as an external root-only env file plus
  loopback-only host publication.

Activation must use the native Agent Server image and native Postgres/Redis
contract. A thin root-owned deployment overlay may bind the external secret env
and replace the host port with loopback only; it may not implement state,
queueing, retries, or telemetry. See
`docs/native-agent-server-production-readiness.md` and
`evidence/native-agent-server-production-readiness-20260822.json`.

### Gate F — native rollout and incumbent retirement plan

The platform direction is already committed. Evidence controls rollout quality
and the order in which incumbent machinery can be retired; it does not reopen
platform selection.

For each DevSpace-only mechanism, choose one disposition:

- **RETIRE** when a mature native component covers the durable need;
- **REJECT** when it is niche, short-horizon, authority-misaligned, or
  speculative parity;
- **DEFER_WITH_FALSIFIER** when a concrete repeated gap has not yet been shown;
- **THIN_BINDING** only when the gap is durable, generalizable, measured, and
  not acceptably covered by a mature ecosystem component.

Production Agent Server activation, persistence, isolation, and connector
continuity remain readiness requirements. A weaker characterization metric may
trigger diagnosis or a thin correction, but cannot by itself veto LangGraph
adoption or cause a broad DevSpace port.

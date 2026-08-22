# DevSpace parity and migration gates

The comparison separates native capability availability from capabilities that
can actually wrap ChatGPT WebChat's private model loop.

| Capability | Native basis | Qualification state | Remaining proof |
|---|---|---:|---|
| Workspace selection | Thin allowed-root registry | Passed locally | Reopen after ChatGPT app reconnect |
| File list/read/write/edit/delete | Deep Agents backend protocol | Passed | Direct WebChat repair |
| Search/glob | Deep Agents backend protocol | Passed | Representative multi-file diagnosis |
| Shell/build/test/Git | Deep Agents `execute` | Passed in isolated container | Representative project workload |
| Binary artifact transfer | Native `upload_files` / `download_files` | Passed with checksum | Direct WebChat binary round trip |
| Skills | Native `SkillsMiddleware` metadata loading | Passed | WebChat selects and reads the correct skill |
| `AGENTS.md` memory | Native `MemoryMiddleware` ordered sources | Passed | Nested project-instruction behavior |
| Context progressive disclosure | Thin explicit MCP projection | Passed | Long task token/quality comparison |
| Durable checkpoint | LangGraph SQLite / Agent Server Store | Passed | Resume from new WebChat chat |
| Agent Server threads/history/state | `langgraph_sdk.threads` | Passed on live v2 custom route | Production deployment persistence |
| Native structured planning | `TodoListMiddleware.WriteTodosInput` + thread state | Passed unit and live v2 round trip | WebChat behavior on a long task |
| Agent Server durable runs/events/cancel | `langgraph_sdk.runs` | Passed on live v2 custom route | Production queue/load behavior |
| Native HITL interrupt/resume | LangGraph `interrupt` + Agent Server `Command(resume)` | Passed on live deterministic graph | Real specialist approval flow |
| Agent Server Store | Native Store with bridge namespace prefix | Adapter passed; prior Store probe passed | Cross-chat state readback |
| Optional specialist agents | Allowlisted Agent Server assistants | Adapter passed; disabled by default | Real specialist usefulness and cost |
| Local isolation | Read-only Docker + private network | Passed baseline | Penetration/negative mount checks |
| Native sandbox provider port | `NativeSandboxProvider` + Deep Agents backend | Passed structurally | Select live provider |
| LangSmith Sandbox | Native SDK + `LangSmithSandbox` | **Blocked: organization feature disabled** | Enable feature or select another provider |
| Persistent PTY / stdin / kill / reconnect | Provider-native command handle | Adapter passed with native contract fake | Live provider qualification |
| Tool observability | LangSmith `trace` metadata only | Implemented fail-open | Live trace receipt and A/B dashboard |
| Tool catalog stability | Frozen 24-tool v2 ABI | Descriptor test ready | ChatGPT scan/reconnect stress |
| Private transport | OpenAI Secure MCP Tunnel | Credentials/client ready | Start bridge + tunnel and scan app |
| Hidden WebChat reasoning checkpoint | No public seam | Not claimable | Remains a WebChat/platform property |
| Hidden WebChat system prompt replacement | No public seam | Not possible through MCP | Use server instructions/skills/context instead |
| Automatic WebChat history summarization | Deep Agents model-loop middleware | Not applicable to WebChat loop | Compare WebChat continuity empirically |

## Migration gates

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

Current observation:

- direct `capability_manifest`, `workspace_open`, bootstrap, `read_file`, and
  failing-test execution passed over Secure MCP Tunnel;
- one direct `edit_file` attempt did not persist and did not produce a usable
  terminal result;
- the host-visible `ZES` resource then disappeared while bridge and tunnel
  health stayed ready;
- an identical local MCP edit passed, so the evidence currently isolates the
  failure above the bridge/backend boundary;
- one controlled tunnel-client restart restored tunnel readiness but did not
  restore the direct resource in the same WebChat turn.

Status: **Gate A partially passed; write persistence and host catalog continuity
failed.** See `evidence/direct-webchat-host-boundary-20260822.json`.

### Gate B — full native context/runtime qualification

Use one representative task to exercise:

- skills and nested `AGENTS.md` discovery;
- artifact transfer;
- Agent Server thread/run/history/Store;
- native todos in thread state;
- native interrupt observation and `Command(resume)` continuation;
- explicit specialist invocation only where justified;
- LangSmith traces without payload values.

Persistent PTY is a subgate, not a blocker for Gate A. It remains held until a
live native sandbox provider is available.

### Gate C — DevSpace versus bridge A/B

Run the same bounded task against identical repository clones:

- DevSpace baseline;
- ChatGPT + native LangChain capability plane.

Compare:

- task correctness and test outcome;
- elapsed time and tool-call count;
- schema/transport/tool failures;
- diff quality and validation completeness;
- recovery after interrupted commands or connector loss;
- context/skill selection quality;
- ceremony and custom infrastructure required.

### Gate D — continuity and catalog failure

After a durable checkpoint:

1. disconnect or restart the tunnel sidecar;
2. reconnect the draft ChatGPT app;
3. open a new chat;
4. recover from repository state plus LangGraph/Agent Server state;
5. verify the tool count and fingerprint remain exact.

This gate distinguishes transport stability from ChatGPT host catalog caching.

### Gate E — production boundary

Require:

- dedicated Agent Server/bridge runtime;
- private Secure MCP Tunnel transport;
- sandbox provider or equivalent strong isolation for untrusted execution;
- explicit assistant and Store namespace allowlists;
- durable state and bounded retention;
- observability with no credentials, source payloads, or hidden reasoning;
- idempotent deployment and rollback.

### Gate F — migration decision

Migrate only when capability is at least equivalent to DevSpace for the target
workload and reliability or operational simplicity is materially better.
Native ecosystem breadth and architectural elegance are not sufficient without
direct workload evidence.

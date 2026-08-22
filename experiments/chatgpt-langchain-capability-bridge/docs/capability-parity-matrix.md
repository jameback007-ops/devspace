# DevSpace parity and migration gates

| Capability | Native basis in prototype | Current status | Required proof |
|---|---|---:|---|
| Workspace selection | Thin registry + allowed roots | Passed locally | Reopen same repo after connector refresh |
| File listing/read | Deep Agents backend | Passed | WebChat uses it on fixture and real repo |
| Search/glob | Deep Agents backend | Passed | Multi-file diagnosis without shell-only fallback |
| Write/edit/delete | Deep Agents backend | Passed | Correct source repair and controlled deletion |
| Shell execution | Deep Agents backend | Passed in isolated container | Representative project build/package install |
| Git/status/diff/commit | Native Git through shell | Passed in disposable worktree | Representative clean-commit workload |
| Worktree lifecycle | Native Git through shell | Passed | Repeat under real repository load |
| Dependency install | Container network + shell | Passed (`pyfiglet==1.0.4`) | Exercise project-native package manager/build |
| Tests/build | Shell | Fixture repair passed, 2 tests | Representative 10–30-file task |
| Long-running process | Backend synchronous execute | Timeout/cancellation passed; persistent session gap | Native sandbox streaming/resume or Agent Server run |
| Durable tool state | LangGraph + SQLite / Agent Server Store | Passed across container restart | Resume from a new WebChat session |
| Hidden reasoning continuation | ChatGPT-owned | Not observable | Must not be claimed from LangGraph state |
| Tracing/evaluation | LangSmith-compatible stack | Not configured | Capture tool/state traces for A/B |
| Tool catalog stability | Stable MCP ABI | Unproven | Disconnect, refresh, reconnect stress test |
| Authentication | None on local loopback | Gap | OAuth-protected remote endpoint |
| Secret isolation | Read-only container, dropped capabilities, explicit environment | Basic negative host-path test passed | Authenticated remote penetration test |
| Artifact transfer | Deep Agents backend methods | Not exposed yet | Add only if real workload requires it |

## Migration gates

### Gate A — direct WebChat coding

ChatGPT must repair the failing fixture itself using primitive calls. No second
model, delegated agent, or hidden coding service is allowed.

Status: **tool plane qualified, ChatGPT-host connection pending**. A deterministic
MCP client repaired the fixture, changed the source, reran tests to `2 passed`,
checked the Git diff, and persisted a checkpoint. This does not substitute for
the model-facing WebChat qualification.

A second rehearsal let the current ChatGPT session choose and interpret each
primitive MCP operation itself. It reached the same valid repair and recovered
its checkpoint after restarting the bridge container, but the requests were
still relayed through Legacy rather than discovered as native tools by the
ChatGPT host. Gate A therefore remains open only at the connector layer.

### Gate B — representative coding parity

Run the same bounded task against two identical repository clones:

- DevSpace baseline;
- this bridge backed by native LangChain components.

Compare correctness, tool failures, elapsed time, recovery, diff quality,
validation, and ceremony.

### Gate C — continuity and connector failure

Interrupt the ChatGPT connector after a checkpoint. Reconnect or open a new
WebChat session and continue from repository state plus LangGraph checkpoint.

The preferred connector path is OpenAI Secure MCP Tunnel. It avoids public
ingress but still leaves ChatGPT tool-snapshot behavior as a testable host-side
failure plane.

### Gate D — production boundary

Use OAuth, a supported sandbox/isolation model, durable storage, tracing, and a
stable deployment path. Do not mount the production VPS root.

### Gate E — migration decision

Migrate only if capability is at least equivalent to DevSpace and reliability
or operational simplicity is materially better. Architecture elegance alone is
not sufficient.

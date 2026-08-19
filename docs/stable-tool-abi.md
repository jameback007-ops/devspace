# Stable MCP Tool ABI

## Problem

ChatGPT custom MCP apps can retain an approved snapshot of tool names and input
schemas after the live server evolves. Starting a new conversation does not
guarantee a new tool snapshot. A backend may therefore register a complete new
surface while one host conversation still exposes an older subset.

DevSpace must not turn that discovery mismatch into a mission-wide dead end.
In particular, current read-only continuation, publication, landing, and
capability state must remain visible without requiring discovery of the newest
top-level tool name.

## ABI v1

The following top-level tools are the stable bootstrap call ABI:

- `execution_scope_status`
- `execution_scope_list`
- `open_workspace`
- `read`
- `exec_command`
- `skill_search`
- `zes_continuation_preflight`
- `self_repository_publication_preflight`
- `self_repository_publish`

ABI v1 freezes their names and the input domains that an older approved client
can already send. Implementations may add optional inputs and additive output
fields. They may not add a required input, remove an existing input, narrow an
existing enum/type/pattern, or remove a bootstrap tool without an ABI-major
review and one explicit host refresh.

The final three tools are deliberately explicit rather than hidden behind a
universal effect RPC. They preserve the approved security boundary for the
current governed continuation and fixed self-repository publication families.
The embedded `execution_scope_status` projection remains the compatibility
route for clients that predate this ABI migration, while the direct tools are
frozen after the one-time refreshed snapshot.

The two self-repository tools are feature-bound: they are required by the ABI
assessment only when the fixed self-repository contract, and respectively its
effect gate, are enabled in that runtime. Disabling a privileged effect family
does not make a minimal runtime ABI-incompatible; enabling it without its
approved stable tool does.

Descriptions, additive structured output, and unrelated new direct tools are
not part of the call-compatibility fingerprint. Runtime startup assesses the
registered descriptors against the ABI contract and returns the result under
`backendRuntime.toolSurface.stableToolAbi`.

## Evidence-bound compatibility requirements

ABI v1 consumes the load-bearing requirements from compatibility evidence
candidate `444ee06b175277fb1db2c74fecd63df10a2d5419` without merging its
research harness into the production implementation:

| Requirement | Production disposition |
|---|---|
| `ABI-001` / `ABI-002` / `ABI-003` | Stable names and prior input domains are frozen. New required inputs, removed inputs, and enum/type/pattern narrowing fail assessment; additive optional inputs remain compatible. |
| `ABI-004` | New read-only control state is projected behind `execution_scope_status` instead of requiring discovery of another top-level bootstrap tool. |
| `ABI-005` | Client catalog freshness remains unknown unless the client supplies an exact epoch/fingerprint or equivalent complete attestation. |
| `ABI-006` | Complete descriptor identity uses canonical JSON, deterministic ordering, and SHA-256 fingerprints. |
| `ABI-007` | `tools/list_changed` and modern list subscriptions are recovery hints only; neither attests that ChatGPT refreshed or approved its app catalog. |
| `ABI-008` | `self_repository_publish` uses the existing digest-bound `planIdSha256` as its stable replay identity. Repeating that identity returns the durable terminal receipt and does not push twice. Adding a second required idempotency input would itself break ABI v1. |
| `ABI-009` | Protocol success and semantically usable output are distinct. Stable high-risk effects return structured terminal state; the Transport Supervisor separately rejects empty, truncated, or ambiguous success. |
| `ABI-010` | No generic arbitrary RPC dispatcher is admitted under a stable name. Fixed effect families retain narrow target and authority contracts. |

The compatibility evidence also verified one bounded existing ChatGPT session
remaining on 53 approved tools while the live Nexus runtime exposed 63. That
observation establishes a stale-client case only; it does not establish the
result of an explicit app refresh, connector reconnect, or new conversation.

## Dynamic capability fabric

Evolving read-only capabilities are projected inside the open structured data
returned by `execution_scope_status`:

```text
execution_scope_status
  -> stableControlPlane
       -> capabilityDirectory
       -> capabilities.primaryMcpRecovery
       -> capabilities.continuationPreflight
       -> capabilities.scopePublicationPreflight
       -> capabilities.selfRepositoryPublicationPreflight
```

The direct tools remain ergonomic aliases for clients whose catalog has been
refreshed. Their absence does not invalidate the embedded server-owned
projection and does not establish writer uncertainty. A missing direct tool
blocks only an operation that genuinely lacks a compatible stable projection;
it must not block unrelated research, validation, or preparation lanes.

`primaryMcpRecovery` adds a capability-aware work gate behind the same stable
bootstrap. A client may attest its complete visible tool list and exact mission
capability needs. The projection then orders catalog repair, stable read-only
projection, typed fallback, or safe turn landing. It never treats an available
fallback as quality-equivalent by default and never transfers an effectful
operation implicitly.

The continuation projector used internally by repository publication may be
deferred to avoid an irrelevant global refresh. The client-facing stable
control plane separately requests the normal continuation projection, so the
presence of any repository candidate cannot suppress runtime/effect preflight
readback for a frozen client.

## Authority and effect boundary

The stable projection is read-only. It accepts no arbitrary repository path,
command, URL, credential, provider target, or effect key. It does not publish,
restart, deploy, retry, terminate, or transfer authority.

High-risk operations remain explicit fixed effect families. Immediately before
mutation they must freshly revalidate the current candidate/runtime, rightful
writer/effect state, immutable effect identity, rollback target, and any
compare-and-swap or lease requirement. An embedded preflight can satisfy the
read phase; it never grants the effect.

## Notifications and refresh

MCP `tools/list_changed` notifications may be emitted as defense in depth, but
they are not the correctness mechanism. Stateless HTTP clients may not retain a
notification channel, and ChatGPT approval policy may still require action
review. Modern `subscriptions/listen` recovery has the same claim ceiling: it
can repair a supporting SDK client's cache, but it does not prove ChatGPT
updated an approved app snapshot. The permanent compatibility mechanism is the
stable ABI plus additive control-plane projection.

One explicit ChatGPT action refresh is still required to migrate an existing
snapshot when it lacks the ABI v1 bootstrap tools or needs a newly privileged
action. Ordinary future additions behind compatible projections should not
require another refresh.

## Change review

Before publication:

1. Run `src/stable-tool-abi.test.ts` and inspect
   `backendRuntime.toolSurface.stableToolAbi` from a real MCP fixture.
2. Confirm old bootstrap calls still validate with their former arguments.
3. Confirm new control state is additive inside the existing open `data`
   payload.
4. Confirm no compatibility route performs a material effect or accepts an
   arbitrary target.
5. Treat any incompatible ABI assessment as a publication blocker until an
   explicit ABI-major migration and host refresh plan exists.
6. Run the Transport Supervisor fault matrix and prove that a repeated
   digest-bound effect identity produces one physical effect and one terminal
   receipt.

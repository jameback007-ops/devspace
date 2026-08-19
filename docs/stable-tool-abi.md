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

## Dynamic capability fabric

Evolving read-only capabilities are projected inside the open structured data
returned by `execution_scope_status`:

```text
execution_scope_status
  -> stableControlPlane
       -> capabilityDirectory
       -> capabilities.continuationPreflight
       -> capabilities.scopePublicationPreflight
       -> capabilities.selfRepositoryPublicationPreflight
```

The direct tools remain ergonomic aliases for clients whose catalog has been
refreshed. Their absence does not invalidate the embedded server-owned
projection and does not establish writer uncertainty. A missing direct tool
blocks only an operation that genuinely lacks a compatible stable projection;
it must not block unrelated research, validation, or preparation lanes.

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
review. The permanent compatibility mechanism is the stable ABI plus additive
control-plane projection.

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

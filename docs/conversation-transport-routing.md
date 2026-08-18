# Conversation Transport Routing

## Purpose

Conversation continuation is a provider-neutral delivery problem. A browser
controller is one possible transport, not the definition of wake or resume.
The routing layer therefore chooses among an attested native RPC transport, a
durable local-agent transport, and a UI-contract fallback without changing the
task, writer, or publication authority model.

## Current evidence boundary

The installed desktop shell visibly contains ChatGPT, ChatGPT Work, and Codex
product modes. Read-only host inspection also found a Codex App Server child
and a local Codex IPC socket. Those facts establish a native Codex control
plane; they do not establish an externally supported Chat/Work conversation
control protocol. Internal renderer messages such as Quick Chat composer
handoff are implementation details and are not treated as an integration
contract.

The Chat/Work native adapter therefore fails closed until a current, explicit
attestation supplies all of the following:

- a supported or registered control surface;
- exact conversation binding;
- direct-input capability;
- transport health;
- post-delivery reconciliation capability.

Presence of the desktop process, a Codex child process, or an IPC socket cannot
substitute for that attestation. Private endpoint replay is deliberately not a
canonical transport.

## Routing policy

Eligible transports must be available, healthy, able to accept direct input,
exactly bound to the intended conversation, and able to reconcile delivery.
Native and local-agent surfaces must be official or registered. UI fallback
must be governed by an explicit UI contract.

The fixed preference order is:

1. native RPC;
2. durable local agent;
3. web UI contract.

Selection is deterministic within one tier. A staged, accepted, or
indeterminate previous delivery blocks all fallback until reconciliation, so a
transport timeout cannot silently duplicate a user message through another
surface.

## Lifecycle separation

Thread lifecycle and transport health are separate observations. A Codex
thread may report a lifecycle error while the App Server remains healthy and
still accepts direct input. Routing therefore evaluates the App Server and
direct-input fields directly instead of collapsing them into one overall
health flag.

## Integration boundary

This slice adds only the provider-neutral routing core and edge adapters. It
does not register MCP tools, modify shared server/configuration files, connect
to the desktop IPC socket, send a prompt, activate Playwright, publish, or
deploy. Existing InteractionBroker binding, permit, lease, and delivery
reconciliation remain the authority-bearing integration points.

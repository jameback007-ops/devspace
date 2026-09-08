# Operator receiver activation and actual Codex review, 2026-09-08

This account supplements a4c062b/2064744; it does not revise their historical
receipts or claim complete operator-wide tracing. Main/Product observability and
Expand's identity/ToolHive work remain separate.

## Operated receiver

The primary connector accepted installation of the source Phoenix/Collector units
and the 2064744 Collector configuration. Native Collector validation passed.
Systemd loaded `IPAddressDeny=::/0 0.0.0.0/0` and
`IPAddressAllow=127.0.0.0/8 ::1/128` for both units before they were started.
Both units were active/running when read back. A socket check connected to the
four localhost endpoints (16006,14317,14318,14319), while all40 attempts against
the host's ten nonloopback IPv4/IPv6 addresses failed. Phoenix16006 and Collector
health13133 returned HTTP200 on localhost. This is observed host-local positive/
negative reachability, not an independent external penetration or authentication
assessment. In particular, it covers Phoenix's gRPC listener, whose bind address
is independent of the HTTP host setting.

The two receiver units were enabled for boot; native systemd returned both
multi-user.target symlinks. No public Phoenix route or login endpoint was exposed.
Later combined health/config/Prometheus inspection was stopped by the host before
execution; it supplies no later health, memory or loss-counter evidence.

Observed tool-output SHA256 references (not remote report file hashes):

- Policy installation/validation: `9910f93ceda168eb22d94639a7acb5176a7d466935df26fa2d720b6994af1630`.
- Unit activation: `7965b4eff69eee196f30eae50ad685e8e6682a47f5f4bc51dac8b0a636c7031f`.
- Endpoint checks: `bfd31af32b0bacd25f6ea8491cb70bde2dc0862fc109bec8ce322ef7d02cbdc1`.
- Boot enablement: `f3af1f0a2fd38b328a1b332e601260716d403d143bd03e831551164c724fd790`.

## Codex default configuration and a useful review

The root producer's config was backed up at mode0600, then only an `[otel]`
table was added. Logs/traces/metrics target Collector14318 and
`log_user_prompt=false`. Parsed equality with the backup confirmed all unrelated
settings unchanged. No credentials were printed and no running App Server or
worker was restarted. Other homes and profile overrides are not covered by this
configuration observation.

`codex --strict-config features list` cannot validate this configuration because
that subcommand does not support the flag. A subsequent actual
`codex exec --strict-config --ephemeral --json --sandbox read-only` review accepted
the default config without any telemetry CLI overrides and completed with native
exit0. It reviewed the existing operator audit query and tests; it was not the
old intentional exit7/0 fixture. Six command-completion records were observed and
the repository remained clean. The parent driver retained visible review output,
status/usage metadata and digests, not raw JSONL, private reasoning or stderr.

Native review output identified two reproducible defects: Python's equality
equated boolean and integer duplicate measurements, and absent byte/timing values
looked like measured zeros. Refine added regression tests, reproduced both, and
implemented type-sensitive comparison plus explicit per-metric coverage. The
15-method query test suite passes; missing totals are null and observed zeros
remain zero. This establishes a scoped review-to-correction outcome, not a
longitudinal model performance gain or an independently closed security audit.

## Ingestion is not session attribution

The driver's exact `session.id` query returned no spans, so its overall end-to-end
assertion failed despite native Codex's successful review. A later independent
bounded native SDK query retrieved20 recent spans from `zes-operator-codex`;
all20 sampled spans lacked `session.id`. One carried `turn.id`; most were
structural observations without allowed events. Neither timestamps nor a healthy
receiver prove that a span belongs to that particular review.

The proposed read of filtered native logs followed by exact log-context/span
correlation was stopped before execution. No correlation report or exact match
was established from that request. Do not infer session identity, reconstruct
private rollouts, fabricate parents, or claim that every Codex session is covered.
The audit query now reports missing session-attribution coverage and explains the
limits of excluding synthetic sessions when those labels are absent.

The corrected audit CLI was subsequently started against Phoenix with a50-span
limit, but its output poll was host-stopped. That query's output is not claimed
as observed or used as a substitute for the blocked exact-correlation request.

- Native review/driver result output: `905d87c286efb3d11a2ff33975f718a2766b48363a99f3f307390052e1ca80e1`.
- Recent20-span query output: `3da64150df7b0c0693697b85690ae73f9aa3fa444235294977bc09bd4eb284f2`.
- Review report location: `/tmp/zes-operator-default-codex-audit-20260908.json`.
  The output references above are not a hash of that file.

## Nexus producer: staged, not deployed

Release `20647443d744-operator-r1` was packaged from the exact clean2064744 source.
Native compiled MCP discovery returned51tools with the existing fingerprint.
The native manifest binds source/tree and package identity:

- source: `20647443d744d91c64cbbd870c97bc8e23d4f209`;
- tree: `70dc82f61f41ea1b76c295196e7a70c89c1201c7`;
- manifest SHA256: `10b715452a06c89af65cf3891c53b6b6584f9aeda09a40003b41d954ca554131`;
- build artifact SHA256: `6846f1304169826c9dda6654baeb15b7a9a9c78b47df4c69edaa8c14c488595f`.

Rollout files name port7688 and enable only the optional local Nexus exporter.
The primary install/start/readiness request was stopped with a host message that
it could not determine the request safety status. There was no executor receipt
for that request. No candidate start, proxy switch, old-slot retirement, recovery
target change or ChatGPT live trace is claimed. Caddy's last observed Nexus
upstream remains7687/728f32c. The prepared2064744 package does not include the
subsequent audit-query source correction from this account.

## Remaining useful work

Actual Nexus producer activation and source-bound live readback remain open.
For Codex, distinguish default launch configuration, recent ingress, missing
session context and existing App Server uptake. Resolve identity using native
source/trace evidence, not temporal proximity. Sustained storage/retention,
power/disk failure and broad field-minimization coverage remain unqualified.
Current host-stopped deployment and correlation requests were not split,
rerouted or delegated. No Product observability authority was added.

## Source validation

The expanded query regression suite first produced seven failures and one error
against the old implementation. After correction all15 test methods passed.
Normal repository typecheck, `npm test`, build and diff checks passed, with logs:

- typecheck: `6c11c2163c626595bd9872d97b9315a2d2392c5a2eda2c8d002ba60cf0daa649`;
- full tests: `be139da738f0cbe4c0c3cdc31f7fc8585074740bd18bae61a17054614ba2c1c6`;
- build: `8961b5be28b68581f4dfeffaf09daac1b11df3f515e9f08cfafcf95a216c810b`.

Only this validation/readback narrative was added after those checks; tested
implementation and tests were unchanged. This source validation does not turn
the staged Nexus release or the failed session-correlation assertion into a pass.

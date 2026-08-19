import type { DatabaseHandle } from "./db/client.js";
import type {
  InteractionBrokerLease,
  InteractionBrokerLeaseClaim,
  InteractionBrokerRecord,
  InteractionBrokerStore,
} from "./interaction-broker.js";
import {
  InteractionSession,
  type InteractionEvidenceRef,
} from "./interaction-harness.js";

export interface DurableInteractionBrokerStore extends InteractionBrokerStore {
  /**
   * Resolve an indeterminate broker checkpoint inside the caller's active
   * SQLite transaction. This is the only lease-free path: it is not a new UI
   * dispatch, and it requires exact external effect readback evidence.
   */
  reconcileIndeterminateSession(input: {
    sessionRef: string;
    expectedExecutionScopeRef: string;
    expectedPayloadDigestSha256: string;
    expectedApprovalRef: string;
    expectedContextRef: string;
    resolution: "effect_absent" | "effect_verified";
    postStateDigestSha256: string;
    evidence: InteractionEvidenceRef[];
    verificationRef: string;
    authorityReadbackRef: string;
    observedAt: string;
  }): InteractionBrokerRecord;
}

interface LeaseRow {
  resource_ref: string;
  lease_id: string;
  holder_scope_ref: string;
  generation: number;
  acquired_at_ms: number;
  expires_at_ms: number;
}

interface SessionRow {
  version: number;
  payload_json: string;
}

/**
 * SQLite-backed implementation of the existing InteractionBroker contract.
 *
 * The store shares DevSpace's WAL database and uses IMMEDIATE transactions for
 * lease and compare-and-swap mutations. The persisted payload is the broker's
 * bounded checkpoint only; interaction payload text and browser credentials
 * are never accepted by this layer.
 */
export class SqliteInteractionBrokerStore implements DurableInteractionBrokerStore {
  constructor(private readonly database: DatabaseHandle) {}

  async claimLease(input: {
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    nowMs: number;
    ttlMs: number;
  }): Promise<InteractionBrokerLeaseClaim> {
    const operation = this.database.sqlite.transaction(() => {
      const current = this.leaseRow(input.resourceRef);
      if (current && current.expires_at_ms > input.nowMs) {
        return {
          acquired: false,
          current: leaseFromRow(current),
        } satisfies InteractionBrokerLeaseClaim;
      }
      const generation = (current?.generation ?? 0) + 1;
      this.database.sqlite.prepare(`
        insert into interaction_broker_leases (
          resource_ref,
          lease_id,
          holder_scope_ref,
          generation,
          acquired_at_ms,
          expires_at_ms
        ) values (?, ?, ?, ?, ?, ?)
        on conflict(resource_ref) do update set
          lease_id = excluded.lease_id,
          holder_scope_ref = excluded.holder_scope_ref,
          generation = excluded.generation,
          acquired_at_ms = excluded.acquired_at_ms,
          expires_at_ms = excluded.expires_at_ms
      `).run(
        input.resourceRef,
        input.leaseId,
        input.holderScopeRef,
        generation,
        input.nowMs,
        input.nowMs + input.ttlMs,
      );
      return {
        acquired: true,
        lease: {
          resourceRef: input.resourceRef,
          leaseId: input.leaseId,
          holderScopeRef: input.holderScopeRef,
          generation,
          acquiredAt: iso(input.nowMs),
          expiresAt: iso(input.nowMs + input.ttlMs),
        },
      } satisfies InteractionBrokerLeaseClaim;
    });
    return operation.immediate();
  }

  async renewLease(input: {
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    nowMs: number;
    ttlMs: number;
  }): Promise<InteractionBrokerLease | undefined> {
    const operation = this.database.sqlite.transaction(() => {
      const current = this.leaseRow(input.resourceRef);
      if (
        !current
        || current.lease_id !== input.leaseId
        || current.holder_scope_ref !== input.holderScopeRef
        || current.expires_at_ms <= input.nowMs
      ) {
        return undefined;
      }
      const expiresAtMs = input.nowMs + input.ttlMs;
      const updated = this.database.sqlite.prepare(`
        update interaction_broker_leases
        set expires_at_ms = ?
        where resource_ref = ?
          and lease_id = ?
          and holder_scope_ref = ?
          and expires_at_ms > ?
      `).run(
        expiresAtMs,
        input.resourceRef,
        input.leaseId,
        input.holderScopeRef,
        input.nowMs,
      );
      if (updated.changes !== 1) return undefined;
      return leaseFromRow({ ...current, expires_at_ms: expiresAtMs });
    });
    return operation.immediate();
  }

  async releaseLease(input: {
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    nowMs: number;
  }): Promise<boolean> {
    const operation = this.database.sqlite.transaction(() => {
      const result = this.database.sqlite.prepare(`
        update interaction_broker_leases
        set expires_at_ms = min(expires_at_ms, ?)
        where resource_ref = ?
          and lease_id = ?
          and holder_scope_ref = ?
      `).run(
        input.nowMs,
        input.resourceRef,
        input.leaseId,
        input.holderScopeRef,
      );
      return result.changes === 1;
    });
    return operation.immediate();
  }

  async loadSession(
    sessionRef: string,
  ): Promise<InteractionBrokerRecord | undefined> {
    return this.sessionRecord(sessionRef);
  }

  async compareAndSwapSession(input: {
    record: Omit<InteractionBrokerRecord, "version">;
    expectedVersion: number;
    resourceRef: string;
    leaseId: string;
    holderScopeRef: string;
    nowMs: number;
  }): Promise<{
    saved: boolean;
    record?: InteractionBrokerRecord;
    current?: InteractionBrokerRecord;
    reason?: "lease_missing" | "lease_mismatch" | "version_conflict";
  }> {
    const operation = this.database.sqlite.transaction(() => {
      const lease = this.leaseRow(input.resourceRef);
      if (!lease || lease.expires_at_ms <= input.nowMs) {
        return {
          saved: false,
          reason: "lease_missing" as const,
        };
      }
      if (
        lease.lease_id !== input.leaseId
        || lease.holder_scope_ref !== input.holderScopeRef
      ) {
        return {
          saved: false,
          reason: "lease_mismatch" as const,
        };
      }
      const current = this.sessionRecord(input.record.sessionRef);
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== input.expectedVersion) {
        return {
          saved: false,
          ...(current ? { current } : {}),
          reason: "version_conflict" as const,
        };
      }
      const saved: InteractionBrokerRecord = {
        ...structuredClone(input.record),
        version: currentVersion + 1,
      };
      this.database.sqlite.prepare(`
        insert into interaction_broker_sessions (
          session_ref,
          version,
          adapter_resource_ref,
          adapter_id,
          current_execution_scope_ref,
          payload_json,
          updated_at_ms
        ) values (?, ?, ?, ?, ?, ?, ?)
        on conflict(session_ref) do update set
          version = excluded.version,
          adapter_resource_ref = excluded.adapter_resource_ref,
          adapter_id = excluded.adapter_id,
          current_execution_scope_ref = excluded.current_execution_scope_ref,
          payload_json = excluded.payload_json,
          updated_at_ms = excluded.updated_at_ms
      `).run(
        saved.sessionRef,
        saved.version,
        saved.adapterResourceRef,
        saved.adapterId,
        saved.currentExecutionScopeRef,
        JSON.stringify(saved),
        Date.parse(saved.updatedAt),
      );
      return {
        saved: true,
        record: structuredClone(saved),
      };
    });
    return operation.immediate();
  }

  reconcileIndeterminateSession(input: {
    sessionRef: string;
    expectedExecutionScopeRef: string;
    expectedPayloadDigestSha256: string;
    expectedApprovalRef: string;
    expectedContextRef: string;
    resolution: "effect_absent" | "effect_verified";
    postStateDigestSha256: string;
    evidence: InteractionEvidenceRef[];
    verificationRef: string;
    authorityReadbackRef: string;
    observedAt: string;
  }): InteractionBrokerRecord {
    if (!this.database.sqlite.inTransaction) {
      throw new Error(
        "Interaction broker reconciliation requires the caller's active SQLite transaction.",
      );
    }
    const current = this.sessionRecord(input.sessionRef);
    if (!current) {
      throw new Error("Interaction broker reconciliation session was not found.");
    }
    if (current.currentExecutionScopeRef !== input.expectedExecutionScopeRef) {
      throw new Error("Interaction broker reconciliation scope ownership changed.");
    }
    const pendingAction = current.checkpoint.pendingAction;
    if (current.checkpoint.state !== "indeterminate" || !pendingAction) {
      throw new Error(
        "Only an indeterminate interaction broker session may be reconciled.",
      );
    }
    if (
      pendingAction.payloadDigestSha256 !== input.expectedPayloadDigestSha256
      || pendingAction.approvalRef !== input.expectedApprovalRef
      || pendingAction.approvalActorRef !== input.expectedExecutionScopeRef
      || pendingAction.binding.contextRef !== input.expectedContextRef
    ) {
      throw new Error("Interaction broker reconciliation permit binding changed.");
    }
    const observedAtMs = Date.parse(input.observedAt);
    if (!Number.isFinite(observedAtMs)) {
      throw new Error("Interaction broker reconciliation observedAt is invalid.");
    }
    const expectedEvidence = evidenceSignature(input.evidence);
    const session = InteractionSession.restore(current.checkpoint, {
      now: () => observedAtMs,
      reconciliationVerifier: (verification) => {
        const verified = verification.identity.executionScopeRef
            === input.expectedExecutionScopeRef
          && verification.action.actionId === pendingAction.actionId
          && verification.action.payloadDigestSha256
            === input.expectedPayloadDigestSha256
          && verification.action.approvalRef === input.expectedApprovalRef
          && verification.action.approvalActorRef
            === input.expectedExecutionScopeRef
          && verification.binding.contextRef === input.expectedContextRef
          && verification.resolution === input.resolution
          && verification.postStateDigestSha256
            === input.postStateDigestSha256
          && evidenceSignature(verification.evidence) === expectedEvidence;
        return verified
          ? {
              verified: true,
              verificationRef: input.verificationRef,
              authorityReadbackRef: input.authorityReadbackRef,
            }
          : { verified: false };
      },
    });
    const checkpoint = session.resolveIndeterminate({
      actionId: pendingAction.actionId,
      resolution: input.resolution,
      binding: pendingAction.binding,
      postStateDigestSha256: input.postStateDigestSha256,
      evidence: input.evidence,
    });
    const next: InteractionBrokerRecord = {
      ...current,
      version: current.version + 1,
      checkpoint,
      updatedAt: input.observedAt,
    };
    const saved = this.database.sqlite.prepare(`
      update interaction_broker_sessions
      set
        version = ?,
        current_execution_scope_ref = ?,
        payload_json = ?,
        updated_at_ms = ?
      where session_ref = ? and version = ?
    `).run(
      next.version,
      next.currentExecutionScopeRef,
      JSON.stringify(next),
      observedAtMs,
      next.sessionRef,
      current.version,
    );
    if (saved.changes !== 1) {
      throw new Error("Interaction broker reconciliation CAS conflict.");
    }
    return structuredClone(next);
  }

  private leaseRow(resourceRef: string): LeaseRow | undefined {
    return this.database.sqlite.prepare(`
      select
        resource_ref,
        lease_id,
        holder_scope_ref,
        generation,
        acquired_at_ms,
        expires_at_ms
      from interaction_broker_leases
      where resource_ref = ?
    `).get(resourceRef) as LeaseRow | undefined;
  }

  private sessionRecord(sessionRef: string): InteractionBrokerRecord | undefined {
    const row = this.database.sqlite.prepare(`
      select version, payload_json
      from interaction_broker_sessions
      where session_ref = ?
    `).get(sessionRef) as SessionRow | undefined;
    if (!row) return undefined;
    const parsed = JSON.parse(row.payload_json) as InteractionBrokerRecord;
    if (parsed.version !== row.version) {
      throw new Error("Interaction broker session payload version mismatch.");
    }
    return structuredClone(parsed);
  }
}

function leaseFromRow(row: LeaseRow): InteractionBrokerLease {
  return {
    resourceRef: row.resource_ref,
    leaseId: row.lease_id,
    holderScopeRef: row.holder_scope_ref,
    generation: row.generation,
    acquiredAt: iso(row.acquired_at_ms),
    expiresAt: iso(row.expires_at_ms),
  };
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function evidenceSignature(evidence: InteractionEvidenceRef[]): string {
  return JSON.stringify(
    evidence
      .map((item) => ({
        kind: item.kind,
        ref: item.ref,
        sha256: item.sha256,
        capturedAt: item.capturedAt,
        sensitive: item.sensitive,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}

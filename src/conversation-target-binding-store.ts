import { randomUUID } from "node:crypto";
import {
  openDatabase,
  type DatabaseHandle,
} from "./db/client.js";
import {
  canonicalJson,
  sha256,
} from "./execution-wake-coordination-model.js";
import type { ConversationTargetKind } from "./conversation-transport-routing.js";

export const CONVERSATION_TARGET_BINDING_AUTHORITY = {
  authority: "executor_local_conversation_target_binding_only",
  canonicalTaskAuthority: false,
  canonicalDecisionAuthority: false,
  writerLeaseAuthority: false,
  effectAuthority: false,
  bridgeAliasValidatedBeforeBinding: true,
  arbitraryThreadIdAccepted: false,
  rawConversationUrlPersisted: false,
} as const;

export interface ConversationTargetBinding {
  schemaVersion: 1;
  targetExecutionScopeRef: string;
  missionRef: string;
  targetAlias: string;
  targetKind: ConversationTargetKind;
  bridgeTargetRefDigestSha256: string;
  bindingRef: string;
  bindingGeneration: number;
  evidenceDigestSha256: string;
  evidenceRefs: string[];
  state: "active" | "superseded" | "held";
  createdAt: string;
  updatedAt: string;
  authority: typeof CONVERSATION_TARGET_BINDING_AUTHORITY;
}

interface BindingRow {
  payload_json: string;
}

export class ConversationTargetBindingStore {
  private readonly database: DatabaseHandle;
  private readonly ownsDatabase: boolean;

  constructor(
    stateDir: string,
    database?: DatabaseHandle,
  ) {
    this.database = database ?? openDatabase(stateDir);
    this.ownsDatabase = database === undefined;
    assertBindingSchema(this.database);
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
  }

  get(
    targetExecutionScopeRef: string,
    missionRef: string,
  ): ConversationTargetBinding | undefined {
    const row = this.database.sqlite.prepare(`
      select payload_json from conversation_transport_bindings
       where target_execution_scope_ref = ? and mission_ref = ? and state = 'active'
       limit 1
    `).get(targetExecutionScopeRef, missionRef) as BindingRow | undefined;
    return row ? JSON.parse(row.payload_json) as ConversationTargetBinding : undefined;
  }

  bind(input: {
    targetExecutionScopeRef: string;
    missionRef: string;
    targetAlias: string;
    targetKind: ConversationTargetKind;
    bridgeTargetRefDigestSha256: string;
    evidenceRefs: string[];
  }): ConversationTargetBinding {
    const now = new Date().toISOString();
    const current = this.get(input.targetExecutionScopeRef, input.missionRef);
    if (current
      && current.targetAlias === input.targetAlias
      && current.targetKind === input.targetKind
      && current.bridgeTargetRefDigestSha256 === input.bridgeTargetRefDigestSha256) {
      return current;
    }
    const bindingGeneration = (current?.bindingGeneration ?? 0) + 1;
    const bindingRef = `ctb_${randomUUID().replaceAll("-", "")}`;
    const evidenceRefs = [...new Set(input.evidenceRefs)].sort();
    const record: ConversationTargetBinding = {
      schemaVersion: 1,
      targetExecutionScopeRef: input.targetExecutionScopeRef,
      missionRef: input.missionRef,
      targetAlias: input.targetAlias,
      targetKind: input.targetKind,
      bridgeTargetRefDigestSha256: input.bridgeTargetRefDigestSha256,
      bindingRef,
      bindingGeneration,
      evidenceDigestSha256: sha256(canonicalJson({
        ...input,
        bindingRef,
        bindingGeneration,
        evidenceRefs,
      })),
      evidenceRefs,
      state: "active",
      createdAt: now,
      updatedAt: now,
      authority: CONVERSATION_TARGET_BINDING_AUTHORITY,
    };
    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare(`
        update conversation_transport_bindings
           set state = 'superseded', updated_at_ms = ?
         where target_execution_scope_ref = ? and mission_ref = ? and state = 'active'
      `).run(Date.parse(now), input.targetExecutionScopeRef, input.missionRef);
      this.database.sqlite.prepare(`
        insert into conversation_transport_bindings (
          binding_ref, target_execution_scope_ref, mission_ref, target_alias,
          target_kind, bridge_target_ref_digest_sha256, binding_generation,
          evidence_digest_sha256, state, payload_json, created_at_ms, updated_at_ms
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.bindingRef,
        record.targetExecutionScopeRef,
        record.missionRef,
        record.targetAlias,
        record.targetKind,
        record.bridgeTargetRefDigestSha256,
        record.bindingGeneration,
        record.evidenceDigestSha256,
        record.state,
        JSON.stringify(record),
        Date.parse(record.createdAt),
        Date.parse(record.updatedAt),
      );
    });
    transaction.immediate();
    return record;
  }
}

function assertBindingSchema(database: DatabaseHandle): void {
  try {
    database.sqlite.prepare(
      "select binding_ref from conversation_transport_bindings limit 1",
    ).get();
  } catch (error) {
    throw new Error(
      "Conversation transport binding persistence is not installed.",
      { cause: error },
    );
  }
}

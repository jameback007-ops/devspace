import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NativeResearchMcpClient, researchPlaneConfigFromEnvironment } from './research-plane.js';
import { ExecutionScopeManager } from './execution-observability.js';
import { ProcessSessionManager } from './process-sessions.js';
import { executionScopeIdentity } from './request-meta.js';

async function normalize(texts: string[], budget: number) {
  const native = new NativeResearchMcpClient();
  // Isolate only the network; execute the real native client normalization.
  (native as any).withClient = async (_route: unknown, _timeout: unknown, operation: any) => operation({
    listTools: async () => ({tools: [{name: 'web_search_exa'}]}),
    callTool: async () => ({content: texts.map(text => ({type: 'text', text}))}),
  });
  return native.callTool(researchPlaneConfigFromEnvironment({}).exa, 'web_search_exa', {query: 'controlled'}, 1000, budget);
}

test('an exact first-block boundary cannot hide omission of a later block', async () => {
  const result = await normalize(['ABCD', 'tail evidence'], 4);
  assert.equal(result.text, 'ABCD');
  assert.equal(result.textTruncated, true);
});

test('inline separators count against the actual native return budget', async () => {
  const result = await normalize(['AAA', 'BBB'], 6);
  assert.ok(result.text.length <= 6);
  assert.equal(result.text, 'AAA\n\nB');
  assert.equal(result.textTruncated, true);
});

test('inline content remains complete when separator and text fit exactly', async () => {
  const result = await normalize(['AAA', 'BBB'], 8);
  assert.equal(result.text, 'AAA\n\nBBB');
  assert.equal(result.textTruncated, false);
});

test('the actual native summary counts errors without charging blocked/interrupted as errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zes-native-summary-package-'));
  const processes = new ProcessSessionManager();
  let now = Date.now();
  const manager = new ExecutionScopeManager({enabled: true, retentionMs: 60000, maxEventsPerScope: 100, idleAfterMs: 1000}, directory, processes, {now: () => now});
  const identity = executionScopeIdentity({'openai/session': 'synthetic-contract-test-only'});
  assert.ok(identity);
  try {
    for (const outcome of ['succeeded', 'error', 'blocked', 'interrupted'] as const) {
      const handle = manager.beginTool(identity, 'read', {});
      now += 10;
      manager.finishTool(handle, outcome);
    }
    const result = manager.audit(identity.scopeRef, identity) as any;
    assert.equal(result.summary.events, 4);
    assert.equal(result.summary.succeeded, 1);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.byTool.read.failed, 1);
    assert.deepEqual(result.events.map((event: any) => event.outcome), ['interrupted', 'blocked', 'error', 'succeeded']);
  } finally {
    manager.close(); processes.shutdown();
    await rm(directory, {recursive: true, force: true});
  }
});

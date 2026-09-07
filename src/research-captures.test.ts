import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as z from 'zod/v4';
import { ResearchCaptureStore, providerText } from './research-captures.js';
import { ResearchPlane, NativeResearchMcpClient, researchPlaneConfigFromEnvironment } from './research-plane.js';
import { registerResearchTool } from './research-tools.js';

const context = { providerRef: 'exa', nativeTool: 'web_search_exa', arguments: {query: 'fixture', numResults: 20} };
const fixture = (extra = {}) => ({content: [{type: 'text', text: 'head\nไทย😀'},
  {type: 'text', text: 'tail-evidence'}], structuredContent: {results: [{id: 'last', value: false}]}, ...extra});
const sha = (x: Buffer) => createHash('sha256').update(x).digest('hex');

async function withStore(run: (store: ResearchCaptureStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'zes-research-capture-test-'));
  try { await run(new ResearchCaptureStore(join(root, 'captures')), root); }
  finally { await rm(root, {recursive: true, force: true}); }
}

test('original native parsed content including structured data survives a small preview', async () => withStore(async (store) => {
  const original = fixture();
  const response = await store.capture(original, context, 4);
  assert.equal(response.text, 'head');
  assert.equal(response.textTruncated, true);
  const raw = await store.resource(response.capture.uri);
  assert.deepEqual(JSON.parse(raw.contents[0].text).result, original);
  assert.equal(response.capture.bytes, Buffer.byteLength(raw.contents[0].text));
  assert.equal(response.capture.captureRef, sha(Buffer.from(raw.contents[0].text)));
}));

test('Unicode windows assemble exact text with every separator and no split surrogate', async () => withStore(async store => {
  const original = fixture();
  const {capture} = await store.capture(original, context, 2);
  let position = 0, assembled = '';
  while (true) {
    const chunk: any = await store.read({captureRef: capture.captureRef, section: 'text', offset: position, length: 3});
    assembled += chunk.text;
    assert.ok(Array.from(chunk.text).length <= 3);
    assert.ok(!chunk.text.includes('\ufffd'));
    if (chunk.nextOffset === null) break;
    position = chunk.nextOffset;
  }
  assert.equal(assembled, providerText(original));
}));

test('missing structured content remains distinct from explicit null and false', async () => withStore(async store => {
  for (const item of [{content: []}, {content: [], structuredContent: null}, {content: [], structuredContent: false}]) {
    const {capture} = await store.capture(item, context, 1);
    const value: any = await store.read({captureRef: capture.captureRef, section: 'structured'});
    assert.equal(value.present, Object.hasOwn(item, 'structuredContent'));
    if (value.present) assert.deepEqual(JSON.parse(value.text), (item as any).structuredContent);
  }
}));

test('native literal find reaches omitted evidence and paginates repeated occurrences', async () => withStore(async store => {
  const original = {content: [{type: 'text', text: 'ไทย😀\n' + 'needle value\n'.repeat(23)}]};
  const {capture} = await store.capture(original, context, 1);
  const first: any = await store.read({captureRef: capture.captureRef, section: 'text', find: 'needle', length: 9});
  assert.equal(first.matches.length, 20);
  assert.equal(first.matches[0].offset, Array.from('ไทย😀\n').length);
  assert.equal(first.limited, true);
  const last: any = await store.read({captureRef: capture.captureRef, section: 'text', find: 'needle', offset: first.nextOffset});
  assert.equal(last.matches.length, 3);
  assert.equal(last.nextOffset, null);
  await assert.rejects(store.read({captureRef: capture.captureRef, section: 'text', find: ''}));
}));

test('error response remains an error but has inspectable retained evidence', async () => withStore(async store => {
  const response = await store.capture(fixture({isError: true}), context, 5);
  assert.equal(response.isError, true);
  assert.equal(response.capture.providerIsError, true);
  assert.equal(JSON.parse((await store.resource(response.capture.uri)).contents[0].text).result.isError, true);
}));

test('file corruption and invalid opaque refs fail, not silent reacquisition', async () => withStore(async store => {
  const {capture} = await store.capture(fixture(), context);
  await writeFile(join(store.root, `${capture.captureRef}.json`), 'corrupt');
  await assert.rejects(store.read({captureRef: capture.captureRef}), /digest/);
  await assert.rejects(store.read({captureRef: '../outside'}), /opaque/);
  await assert.rejects(store.read({captureRef: 'a'.repeat(64)}));
}));

test('symlink capture root and file are rejected', async () => withStore(async (store, root) => {
  await mkdir(join(root, 'other'), {mode: 0o700});
  const linkedRoot = join(root, 'linked');
  await symlink(join(root, 'other'), linkedRoot);
  await assert.rejects(new ResearchCaptureStore(linkedRoot).capture(fixture(), context));
  const {capture} = await store.capture(fixture(), context);
  const target = join(store.root, `${capture.captureRef}.json`);
  const bytes = await readFile(target);
  await rm(target);
  const other = join(root, 'other', 'content.json');
  await writeFile(other, bytes);
  await symlink(other, target);
  await assert.rejects(store.read({captureRef: capture.captureRef}));
}));

test('malformed result, invalid preview, oversize and invalid window never become success', async () => withStore(async store => {
  await assert.rejects(store.capture({content: 'bad'}, context));
  await assert.rejects(store.capture({content: [{type: 'text', text: 2}]}, context));
  await assert.rejects(store.capture(fixture(), context, 0));
  const limited = new ResearchCaptureStore(store.root, 1024);
  await assert.rejects(limited.capture({content: [{type: 'text', text: 'x'.repeat(2000)}]}, context), /size/);
  const {capture} = await store.capture(fixture(), context);
  await assert.rejects(store.read({captureRef: capture.captureRef, section: 'text', offset: -1}));
  await assert.rejects(store.read({captureRef: capture.captureRef, section: 'text', offset: 999}));
  await assert.rejects(store.read({captureRef: capture.captureRef, section: 'bogus' as any}));
}));

test('concurrent independent captures do not overwrite, and another store instance reads them', async () => withStore(async store => {
  const responses = await Promise.all(Array.from({length: 8}, (_, n) => store.capture(fixture({tag: n}), context, 10)));
  assert.equal(new Set(responses.map(r => r.capture.captureRef)).size, 8);
  const reader = new ResearchCaptureStore(store.root);
  for (const [n, r] of responses.entries()) assert.equal(JSON.parse((await reader.resource(r.capture.uri)).contents[0].text).result.tag, n);
  assert.ok((await readdir(store.root)).every(name => !name.endsWith('.partial')));
}));

test('capture provenance never spreads route credentials or arbitrary context fields', async () => withStore(async store => {
  const result = await store.capture(fixture(), {...context, apiKey: 'SECRET_CANARY', headers: {Authorization: 'SECRET_CANARY'}} as any);
  const raw = (await store.resource(result.capture.uri)).contents[0].text;
  assert.ok(!raw.includes('SECRET_CANARY'));
  assert.equal(JSON.parse(raw).requestSha256, createHash('sha256').update(JSON.stringify(context.arguments)).digest('hex'));
}));

test('a fresh process reads an existing capture without provider or writer', async () => withStore(async (store) => {
  const result = await store.capture(fixture(), context);
  const before = await readFile(join(store.root, `${result.capture.captureRef}.json`));
  const source = new URL('./research-captures.ts', import.meta.url).href;
  const script = `import {ResearchCaptureStore} from ${JSON.stringify(source)};\nconst r=await new ResearchCaptureStore(process.argv[1]).read({captureRef:process.argv[2],section:'text'});console.log(JSON.stringify(r));`;
  const child = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script, store.root, result.capture.captureRef],
    {encoding: 'utf8', timeout: 10000, maxBuffer: 100000, stdio: ['ignore', 'pipe', 'pipe']});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).text, providerText(fixture()));
  assert.equal(sha(await readFile(join(store.root, `${result.capture.captureRef}.json`))), sha(before));
}));

async function withNativeMcp(run: (f: any) => Promise<void>) {
  await withStore(async (store, root) => {
    const payload = {content: Array.from({length: 20}, (_, index) => ({type: 'text' as const,
      text: `SOURCE-${index + 1} https://example.org/paper/${index + 1}\n` + `Evidence-${index}-ไทย😀 `.repeat(600)})),
      structuredContent: {results: Array.from({length: 20}, (_, i) => ({id: i + 1, selected: false}))}};
    let calls = 0;
    const provider = new McpServer({name: 'native-provider-fixture', version: '1'});
    provider.registerTool('web_search_exa', {inputSchema: {query: z.string(), numResults: z.number()}}, async input => {
      calls++; assert.equal(input.numResults, 20); return payload;
    });
    const providerClient = new Client({name: 'native-capture-client', version: '1'});
    const [pc, ps] = InMemoryTransport.createLinkedPair();
    await provider.connect(ps); await providerClient.connect(pc);
    const config = researchPlaneConfigFromEnvironment({DEVSPACE_RESEARCH_MAX_OUTPUT_CHARACTERS: '5000'});
    const nativeClient = new NativeResearchMcpClient(store);
    // Replace only connection admission with native in-memory transport, not the
    // callTool/retention implementation; no remote endpoint or credentials used.
    (nativeClient as any).withClient = async (_r: unknown, _t: unknown, operation: any) => operation(providerClient);
    const plane = new ResearchPlane(config, nativeClient, store);
    const server = new McpServer({name: 'nexus-candidate', version: '1'});
    registerResearchTool(server, {widgets: 'off', stateDir: root} as any,
      ((s: any, name: string, options: any, callback: any) => s.registerTool(name, options, callback)) as any, plane);
    const reader = new Client({name: 'different-harness-reader', version: '1'});
    const [rc, rs] = InMemoryTransport.createLinkedPair();
    await server.connect(rs); await reader.connect(rc);
    try { await run({store, plane, reader, payload, getCalls: () => calls}); }
    finally { await reader.close(); await server.close(); await providerClient.close(); await provider.close(); }
  });
}

test('actual MCP registration returns resource link, retains all20 results and reads tail without provider replay', async () => {
  await withNativeMcp(async ({reader, payload, getCalls}: any) => {
    const result = await reader.callTool({name: 'research', arguments: {action: 'open_world_search', query: 'fixture', maxResults: 20, responseMode: 'reference', previewCharacters: 300}});
    assert.notEqual(result.isError, true);
    const data = result.structuredContent.data;
    assert.equal(getCalls(), 1);
    assert.equal(data.result.capture.contentBlocks, 20);
    assert.ok(Array.from(data.result.text).length <= 300);
    const linked = result.content.find((b: any) => b.type === 'resource_link');
    assert.ok(linked);
    const full = await reader.readResource({uri: linked.uri});
    assert.deepEqual(JSON.parse(full.contents[0].text).result, payload);
    const text = providerText(payload);
    const location = Array.from(text.slice(0, text.indexOf('SOURCE-20'))).length;
    const found = await reader.callTool({name: 'research', arguments: {action: 'capture_read', captureRef: data.result.capture.captureRef,
      section: 'text', find: 'SOURCE-20', length: 100}});
    assert.equal(found.structuredContent.data.matches[0].offset, location);
    const page = await reader.callTool({name: 'research', arguments: {action: 'capture_read', captureRef: data.result.capture.captureRef,
      section: 'text', offset: location, length: 100}});
    assert.ok(page.structuredContent.data.text.startsWith('SOURCE-20'));
    const structured = await reader.callTool({name: 'research', arguments: {action: 'capture_read', captureRef: data.result.capture.captureRef,
      section: 'structured', length: 3000}});
    assert.deepEqual(JSON.parse(structured.structuredContent.data.text), payload.structuredContent);
    assert.equal(getCalls(), 1);
  });
});

test('inline compatibility and reference mode differ only in delivery, not provider query breadth', async () => {
  await withNativeMcp(async ({plane, payload, getCalls}: any) => {
    const inline = await plane.operate({action: 'open_world_search', query: 'fixture', maxResults: 20});
    assert.equal(inline.result.textTruncated, true);
    assert.equal(inline.result.capture, undefined);
    const reference = await plane.operate({action: 'open_world_search', query: 'fixture', maxResults: 20, responseMode: 'reference', previewCharacters: 500});
    assert.equal(reference.result.capture.contentBlocks, payload.content.length);
    assert.equal(getCalls(), 2); // two intentionally separate acquisitions
    const read = await plane.operate({action: 'capture_read', captureRef: reference.result.capture.captureRef, section: 'manifest'});
    assert.equal(read.manifest.contentBlocks, 20);
    assert.equal(getCalls(), 2);
  });
});

test('provider isError propagates through registered tool while capture remains readable', async () => {
  await withNativeMcp(async ({reader, payload, getCalls}: any) => {
    payload.isError = true;
    const response = await reader.callTool({name: 'research', arguments: {action: 'open_world_search', query: 'fixture', maxResults: 20,
      responseMode: 'reference', previewCharacters: 30}});
    assert.equal(response.isError, true);
    const ref = response.structuredContent.data.result.capture.captureRef;
    const retained = await reader.callTool({name: 'research', arguments: {action: 'capture_read', captureRef: ref}});
    assert.equal(retained.structuredContent.data.manifest.providerIsError, true);
    assert.equal(getCalls(), 1);
  });
});

test('storage failure after provider success is reported without inline fallback or retry', async () => {
  await withNativeMcp(async ({store, reader, getCalls}: any) => {
    await writeFile(store.root, 'intentional directory collision');
    const response = await reader.callTool({name: 'research', arguments: {action: 'open_world_search', query: 'fixture', maxResults: 20,
      responseMode: 'reference', previewCharacters: 30}});
    assert.equal(response.isError, true);
    assert.equal(getCalls(), 1);
    assert.equal(response.structuredContent.data.status, 'error');
    assert.equal(response.structuredContent.data.result, undefined);
  });
});

test('invalid response mode or missing store is rejected before provider invocation', async () => {
  const plane = new ResearchPlane(researchPlaneConfigFromEnvironment({}), {callTool: async () => {throw new Error('SHOULD_NOT_CALL');}} as any);
  await assert.rejects(plane.operate({action: 'open_world_search', query: 'fixture', responseMode: 'reference'}), /provider not called/);
  await assert.rejects(plane.operate({action: 'open_world_search', query: 'fixture', responseMode: 'wrong' as any}), /mode/);
});

test('legacy client silently dropping the capture option cannot report capture success', async () => withStore(async store => {
  let calls = 0;
  const legacy = {callTool: async () => {calls++; return {text: 'truncated', isError: false};}};
  const plane = new ResearchPlane(researchPlaneConfigFromEnvironment({}), legacy as any, store);
  await assert.rejects(plane.operate({action: 'open_world_search', query: 'fixture', responseMode: 'reference'}), /no capture/);
  assert.equal(calls, 1);
}));

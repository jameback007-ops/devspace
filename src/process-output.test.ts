import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessOutputLog } from "./process-output-log.js";
import { ProcessInputError, ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";

const command = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
const input = (snapshot: ProcessSnapshot) => ({
  workspaceId: "replay-test",
  sessionId: snapshot.outputSessionId!,
  processRef: snapshot.processRef!,
  waitTimeMs: 0,
});
const start = (manager: ProcessSessionManager, code: string, yieldTimeMs = 1000) => manager.start({
  workspaceId: "replay-test", cwd: process.cwd(), command: command(code), yieldTimeMs,
});

test("retained output uses independent lossless Unicode pages and stable cursors", () => {
  const log = new ProcessOutputLog(100_000);
  const text = "a🙂ไทย\n".repeat(1000);
  log.append(text);
  const before = [log.retainedCharacters, log.retainedChunks, log.latestSequence];
  assert.deepEqual(log.read(0, 256), log.read(0, 256));
  let cursor = 0;
  let actual = "";
  for (;;) {
    const page = log.read(cursor, 256);
    assert.equal(page.gap, false);
    assert.ok(Array.from(page.output).length <= 256);
    actual += page.output;
    cursor = page.nextSequence;
    if (!page.hasMore) break;
  }
  assert.equal(actual, text);
  assert.deepEqual([log.retainedCharacters, log.retainedChunks, log.latestSequence], before);
  assert.equal(log.read(cursor, 256).output, "");
});

test("retention exposes eviction gaps and independently bounds tiny events", () => {
  const log = new ProcessOutputLog(10, 3);
  for (let index = 0; index < 10_000; index++) log.append("🙂");
  assert.equal(log.retainedChunks, 3);
  assert.equal(log.retainedCharacters, 3);
  const page = log.read(0, 256);
  assert.equal(page.output, "🙂🙂🙂");
  assert.equal(page.gap, true);
  assert.equal(page.droppedThroughSequence, 9997);
  assert.equal(page.nextSequence, 10_000);
  assert.equal(log.read(9997, 256).gap, false);
  assert.throws(() => log.read(10_001, 256), { code: "PROCESS_OUTPUT_CURSOR_AHEAD" });
  for (const cursor of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => log.read(cursor, 256), { code: "PROCESS_OUTPUT_CURSOR_INVALID" });
  }
  const large = new ProcessOutputLog(1000);
  large.append("x".repeat(10_000));
  assert.ok(large.retainedCharacters <= 1000);
  assert.equal(large.read(0, 1000).gap, true);
});

test("fast terminal commands remain observable after legacy consume, without reviving controls", async (t) => {
  const manager = new ProcessSessionManager();
  t.after(() => manager.shutdown());
  const done = await start(manager, "console.log('retained'); process.exitCode=7");
  assert.equal(done.sessionId, undefined);
  assert.ok(done.outputSessionId);
  assert.match(done.processRef!, /^prc_[a-f0-9]{32}$/);
  const first = await manager.readOutput(input(done));
  const second = await manager.readOutput(input(done));
  assert.deepEqual(first, second);
  assert.equal(first.output, done.output);
  assert.equal(first.exitCode, 7);
  assert.equal(first.completeFromRequestedCursor, true);
  assert.equal(first.outputDigestSha256, done.outputDigestSha256);
  assert.deepEqual(manager.inspect(), []);
  await assert.rejects(manager.write({ workspaceId: "replay-test", sessionId: done.outputSessionId! }), /Unknown process session/);
});

test("two event-driven observers and legacy stdin/drain all receive the same output", async (t) => {
  const manager = new ProcessSessionManager();
  t.after(() => manager.shutdown());
  const running = await start(manager, "process.stdin.once('data',d=>{process.stdout.write(d);process.exit(0)})", 0);
  const observe = { ...input(running), waitTimeMs: 5000 };
  const first = manager.readOutput(observe);
  const second = manager.readOutput(observe);
  const legacy = manager.write({
    workspaceId: "replay-test", sessionId: running.sessionId!, chars: "shared-canary\n", yieldTimeMs: 1000,
  });
  const [a, b, control] = await Promise.all([first, second, legacy]);
  assert.equal(a.output, "shared-canary\n");
  assert.equal(b.output, a.output);
  assert.equal(a.nextSequence, b.nextSequence);
  assert.equal(control.output, a.output);
  assert.equal(control.running, false);
  assert.equal((await manager.readOutput(input(running))).output, a.output);
});

test("a satisfied cursor waits for NEW output, not the already resolved legacy output promise", async (t) => {
  const manager = new ProcessSessionManager();
  t.after(() => manager.shutdown());
  const running = await start(manager, "console.log('first');process.stdin.once('data',d=>{console.log('second');process.exit(0)})", 0);
  const first = await manager.readOutput({ ...input(running), waitTimeMs: 5000 });
  assert.match(first.output, /first/);
  const timeout = await manager.readOutput({ ...input(running), afterSequence: first.nextSequence, waitTimeMs: 15 });
  assert.equal(timeout.output, "");
  assert.equal(timeout.wakeReason, "timeout");
  const waiting = manager.readOutput({ ...input(running), afterSequence: first.nextSequence, waitTimeMs: 5000 });
  await manager.write({ workspaceId: "replay-test", sessionId: running.sessionId!, chars: "go\n", yieldTimeMs: 1000 });
  const next = await waiting;
  assert.match(next.output, /second/);
  assert.doesNotMatch(next.output, /first/);
});

test("workspace and process-incarnation mismatch cannot read or control another process", async (t) => {
  const first = new ProcessSessionManager();
  const second = new ProcessSessionManager();
  t.after(() => { first.shutdown(); second.shutdown(); });
  const a = await start(first, "console.log('a')");
  const b = await start(second, "console.log('b')");
  assert.equal(a.outputSessionId, b.outputSessionId);
  await assert.rejects(second.readOutput(input(a)), { code: "PROCESS_OUTPUT_IDENTITY_MISMATCH" });
  await assert.rejects(first.readOutput({ ...input(a), workspaceId: "other" }), { code: "PROCESS_OUTPUT_UNAVAILABLE" });
  await assert.rejects(first.readOutput({ ...input(a), afterSequence: 1_000_000 }), { code: "PROCESS_OUTPUT_CURSOR_AHEAD" });
  assert.equal((await second.readOutput(input(b))).output, "b\n");
});

test("timeouts, cancellation, mailbox wake and waiter limits never signal the child or leak waiters", async (t) => {
  const manager = new ProcessSessionManager({ maxOutputWaiters: 1 });
  t.after(() => manager.shutdown());
  const running = await start(manager, "process.stdin.resume()", 0);
  const waitingInput = { ...input(running), waitTimeMs: 5000 };
  const abort = new AbortController();
  const pending = manager.readOutput({ ...waitingInput, signal: abort.signal });
  await assert.rejects(manager.readOutput(waitingInput), { code: "PROCESS_OUTPUT_BUSY" });
  abort.abort();
  await assert.rejects(pending, { code: "PROCESS_OUTPUT_ABORTED" });
  for (let index = 0; index < 10; index++) {
    const timed = await manager.readOutput({ ...waitingInput, waitTimeMs: 1 });
    assert.equal(timed.wakeReason, "timeout");
  }
  const mail = await manager.readOutput({ ...waitingInput, externalWake: Promise.resolve() });
  assert.equal(mail.wakeReason, "mailbox");
  assert.equal(manager.inspect()[0].running, true);
  const last = manager.readOutput(waitingInput);
  const rejected = assert.rejects(last, { code: "PROCESS_OUTPUT_UNAVAILABLE" });
  manager.shutdown();
  await rejected;
});

test("observation does not extend completion TTL", async (t) => {
  const manager = new ProcessSessionManager({ completedSessionTtlMs: 150 });
  t.after(() => manager.shutdown());
  const done = await start(manager, "console.log('ttl')");
  const before = await manager.readOutput(input(done));
  await delay(30);
  const after = await manager.readOutput(input(done));
  assert.equal(after.expiresAt, before.expiresAt);
  await delay(170);
  await assert.rejects(manager.readOutput(input(done)), { code: "PROCESS_OUTPUT_UNAVAILABLE" });
});

test("completed replay has a count bound and does not consume active-process capacity", async (t) => {
  const manager = new ProcessSessionManager({ maxConcurrentSessions: 1, maxCompletedOutputSessions: 2 });
  t.after(() => manager.shutdown());
  const first = await start(manager, "console.log('one')");
  const second = await start(manager, "console.log('two')");
  const third = await start(manager, "console.log('three')");
  await assert.rejects(manager.readOutput(input(first)), { code: "PROCESS_OUTPUT_UNAVAILABLE" });
  assert.equal((await manager.readOutput(input(second))).output, "two\n");
  assert.equal((await manager.readOutput(input(third))).output, "three\n");
});

test("native pipe decoding preserves split multibyte UTF-8 for replay and legacy", async (t) => {
  const manager = new ProcessSessionManager();
  t.after(() => manager.shutdown());
  const done = await start(manager, "process.stdout.write(Buffer.from([0xf0,0x9f]));setTimeout(()=>process.stdout.write(Buffer.from([0x99,0x82])),30)");
  assert.equal(done.output, "🙂");
  assert.equal((await manager.readOutput(input(done))).output, "🙂");
});

test("terminal gap is explicit and response pagination does not silently skip history", async (t) => {
  const manager = new ProcessSessionManager({ maxBufferCharacters: 1024 });
  t.after(() => manager.shutdown());
  const done = await start(manager, "process.stdout.write('x'.repeat(4096))");
  const first = await manager.readOutput({ ...input(done), maxOutputTokens: 1 });
  assert.equal(first.gap, true);
  assert.equal(first.hasMore, true);
  assert.equal(first.outputComplete, false);
  assert.equal(first.completeFromRequestedCursor, false);
  const all = await manager.readOutput(input(done));
  assert.equal(all.output.length, 1024);
  assert.equal(all.outputComplete, true);
  assert.equal(all.completeFromRequestedCursor, false);
});

test("empty process completion wakes observers without requiring output", async (t) => {
  const manager = new ProcessSessionManager();
  t.after(() => manager.shutdown());
  const running = await start(manager, "process.stdin.once('data',()=>process.exit(0))", 0);
  const a = manager.readOutput({ ...input(running), waitTimeMs: 5000 });
  const b = manager.readOutput({ ...input(running), waitTimeMs: 5000 });
  await manager.write({ workspaceId: "replay-test", sessionId: running.sessionId!, chars: "exit\n", yieldTimeMs: 1000 });
  for (const page of await Promise.all([a, b])) {
    assert.equal(page.output, "");
    assert.equal(page.wakeReason, "exit");
    assert.equal(page.outputComplete, true);
  }
});

test("invalid process limits are rejected before creating a child", async (t) => {
  for (const field of ["yieldTimeMs", "maxOutputTokens"] as const) {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await t.test(`${field}=${value}`, async (t) => {
        const manager = new ProcessSessionManager();
        t.after(() => manager.shutdown());
        await assert.rejects(manager.start({
          workspaceId: "replay-test", cwd: process.cwd(),
          command: command("process.stdin.resume();setTimeout(()=>process.exit(0),1000)"),
          yieldTimeMs: 0, [field]: value,
        }), /non-negative/);
        assert.deepEqual(manager.inspect(), [], "a rejected request must not leave an unreturned child");
      });
    }
  }
});

test("invalid process write limits cannot deliver stdin before rejecting", async (t) => {
  for (const field of ["yieldTimeMs", "maxOutputTokens"] as const) {
    await t.test(field, async (t) => {
      const manager = new ProcessSessionManager();
      t.after(() => manager.shutdown());
      const running = await start(manager,
        "require('readline').createInterface({input:process.stdin}).on('line',line=>{process.stdout.write(line+'\\n',()=>{if(line==='BARRIER')process.exit(0)})});setTimeout(()=>process.exit(2),3000)", 0);
      await assert.rejects(manager.write({
        workspaceId: "replay-test", sessionId: running.sessionId!,
        chars: "UNEXPECTED_SIDE_EFFECT\n", yieldTimeMs: 0, [field]: -1,
      }), /non-negative/);
      const barrier = await manager.write({
        workspaceId: "replay-test", sessionId: running.sessionId!, chars: "BARRIER\n", yieldTimeMs: 2000,
      });
      assert.equal(barrier.running, false);
      assert.equal(barrier.output, "BARRIER\n", "rejected input must never reach the child");
    });
  }
});

test("stdin pipe errors cannot crash the manager host or corrupt retained output", {
  skip: process.platform === "win32" ? "native fd-close fixture uses a POSIX exec shell" : false,
  timeout: 10_000,
}, async () => {
  // Run the manager in a disposable process: the original unhandled EPIPE
  // terminates Node itself and cannot be caught by an in-process assertion.
  const fixture = "require('fs').closeSync(0);console.log('STDIN_CLOSED');setTimeout(()=>process.exit(0),1500)";
  const childCommand = `exec ${command(fixture)}`;
  const driver = `
    import assert from 'node:assert/strict';
    import { ProcessSessionManager } from './src/process-sessions.ts';
    const manager = new ProcessSessionManager();
    try {
      const running = await manager.start({workspaceId:'pipe-fixture',cwd:process.cwd(),command:${JSON.stringify(childCommand)},yieldTimeMs:0});
      const observation = {workspaceId:'pipe-fixture',sessionId:running.outputSessionId,processRef:running.processRef,waitTimeMs:2000};
      const ready = await manager.readOutput(observation);
      assert.equal(ready.output,'STDIN_CLOSED\\n');
      await assert.rejects(manager.write({workspaceId:'pipe-fixture',sessionId:running.sessionId,chars:'bounded-fixture\\n',yieldTimeMs:50}),{name:'ProcessInputError',code:'EPIPE'});
      const replay = await manager.readOutput({...observation,waitTimeMs:0});
      assert.equal(replay.output,ready.output);
      assert.equal(replay.outputDigestSha256,ready.outputDigestSha256);
      assert.equal(replay.stdinError.code,'EPIPE');
      assert.equal(replay.stdinError.delivery,'unknown');
      assert.equal(manager.inspect()[0].running,true);
      await assert.rejects(manager.write({workspaceId:'pipe-fixture',sessionId:running.sessionId,chars:'not-replayed\\n'}),{name:'ProcessInputError',code:'EPIPE'});
      const stopped = await manager.write({workspaceId:'pipe-fixture',sessionId:running.sessionId,chars:'\\u0003',yieldTimeMs:2000});
      assert.equal(stopped.running,false);
      const other = await manager.start({workspaceId:'pipe-fixture',cwd:process.cwd(),command:${JSON.stringify(command("console.log('UNRELATED_OK')"))},yieldTimeMs:2000});
      assert.equal(other.output,'UNRELATED_OK\\n');
      assert.equal(other.stdinError,undefined);
      console.log('HOST_SURVIVED_PIPE_FAILURE');
    } finally { manager.shutdown(); }
  `;
  const result = await promisify(execFile)(process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", driver],
    { cwd: process.cwd(), timeout: 8000, maxBuffer: 128_000 });
  assert.match(result.stdout, /HOST_SURVIVED_PIPE_FAILURE/);
});

test("backpressured stdin retains bounded interaction yield without waiting for drain", async (t) => {
  const manager = new ProcessSessionManager();
  t.after(() => manager.shutdown());
  const running = await start(manager, "setTimeout(()=>process.exit(0),3000)", 0);
  const before = performance.now();
  const snapshot = await manager.write({
    workspaceId: "replay-test", sessionId: running.sessionId!,
    chars: "x".repeat(1024 * 1024), yieldTimeMs: 5,
  });
  assert.equal(snapshot.running, true);
  assert.ok(performance.now() - before < 1000, "must not wait indefinitely for a child that does not read");
});

test("stdin failure projection retains only a bounded native code, not private error content", () => {
  const error = new ProcessInputError(Object.assign(new Error("secret-stdin-content"), { code: "EPIPE" }));
  assert.equal(error.code, "EPIPE");
  assert.doesNotMatch(error.message, /secret-stdin-content/);
  assert.match(error.message, /partial/);
  assert.equal(new ProcessInputError({ code: "unsafe code with payload" }).code, "STDIN_WRITE_FAILED");
});

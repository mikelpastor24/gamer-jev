import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { DiagnosticEvent } from "../src/core/diagnostics.js";
import { parseCliOptions } from "../src/config/cli-options.js";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { DemoGameReader } from "../src/profiles/demo.js";
import { bindGameReader } from "../src/profiles/registry.js";
import { createStateObserver } from "../src/observation/state.js";
import { RequestBudget } from "../src/providers/requests.js";
import { createDecisionProvider } from "../src/providers/factory.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { runAgentHeadless } from "../src/runner/agent-headless.js";
import { createDiagnosticLogger } from "../src/runner/diagnostics.js";
import { openSessionLog } from "../src/runner/session-log.js";

test("diagnostics redact credentials in both outputs and keep routine console output quiet", () => {
  const records: unknown[] = [];
  const lines: string[] = [];
  const diagnostics = createDiagnosticLogger((event) => records.push(event), {
    secrets: ["private-typesafe-fixture"], writeLine: (line) => lines.push(line),
  });
  diagnostics({ component: "agent", level: "debug", event: "fixture", frame: 12, data: {
    text: "private-typesafe-fixture", nested: { TYPESAFE_API_KEY: "unrecognized-key", password: "another-secret" },
    authorization: "Bearer hidden-token", unrelatedText: "Bearer unrecognized-token",
  } });
  assert.equal(records.length, 1); assert.equal(lines.length, 0);
  diagnostics({ component: "jev", level: "error", event: "fixture-failure", frame: 12, data: { reason: "private-typesafe-fixture" } });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\[jev\] error fixture-failure frame=12/);
  assert.doesNotMatch(JSON.stringify({ records, lines }), /private-typesafe-fixture|unrecognized-key|another-secret|hidden-token|unrecognized-token/);
  const verbose = createDiagnosticLogger(() => {}, { verbose: true, writeLine: (line) => lines.push(line) });
  verbose({ component: "game-reader", level: "debug", event: "read" });
  assert.equal(lines.length, 2);
  assert.equal(parseCliOptions(["--demo", "--debug"]).debug, true);
  assert.equal(parseCliOptions(["--demo"]).debug, false);
});

test("JSONL recordings redact content, report oversized events, continue recording, and close safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-log-"));
  const path = join(directory, "local.jsonl");
  let notifications = 0;
  const log = openSessionLog(path, { secrets: ["private-key"], maxBytes: 1024, onLimit: () => { notifications++; } });
  try {
    log.record({ type: "session", goal: "Never log private-key", apiKey: "another-secret" });
    log.record({ type: "large", value: "Long fixture 🙂".repeat(200) });
    log.record({ type: "latest" });
    log.close(); log.close(); log.record({ type: "after-close" });
    const text = await readFile(path, "utf8");
    const records = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.doesNotMatch(text, /private-key|another-secret/);
    assert.ok(!records.some((record) => record.event.type === "large" || record.event.type === "after-close"));
    assert.equal(records.length, 3);
    assert.equal(records[0].event.type, "session");
    assert.equal(records[1].event.type, "log-event-omitted");
    assert.ok(records[1].event.eventBytes > 1024);
    assert.equal(records[2].event.type, "latest");
    assert.equal(notifications, 0); assert.ok((await stat(path)).size <= 1024);
  } finally { log.close(); await rm(directory, { recursive: true, force: true }); }
});

test("rolling JSONL replaces oldest complete events with the newest chronological suffix across repeated evictions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-rolling-log-"));
  const path = join(directory, "local.jsonl");
  let notifications = 0, evictions = 0, previousFirst = 0;
  const log = openSessionLog(path, { maxBytes: 1024, secrets: ["private-key"], onLimit: () => { notifications++; } });
  try {
    for (let sequence = 0; sequence < 60; sequence++) {
      log.record({ type: "fixture", sequence, text: "Pokémon 🙂\n".repeat(sequence % 4 + 1), credential: "private-key", apiKey: "other-secret" });
      const text = await readFile(path, "utf8");
      assert.ok(Buffer.byteLength(text) <= 1024); assert.ok(text.endsWith("\n"));
      assert.doesNotMatch(text, /private-key|other-secret|�/);
      const events = text.trim().split("\n").map(line => JSON.parse(line).event);
      assert.equal(events.at(-1).sequence, sequence);
      assert.deepEqual(events.map(event => event.sequence), Array.from({ length: events.length }, (_, index) => sequence - events.length + index + 1));
      assert.ok(events[0].sequence >= previousFirst);
      if (events[0].sequence > previousFirst) evictions++;
      previousFirst = events[0].sequence;
    }
    assert.ok(evictions > 5); assert.equal(notifications, 1);
    log.record({ type: "stop", reason: "Latest stop reason remains available." });
    log.close();
    const events = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line).event);
    assert.equal(events.at(-1).type, "stop"); assert.ok(events.every(event => event.sequence !== 0));
  } finally { log.close(); await rm(directory, { recursive: true, force: true }); }
});

test("rolling JSONL handles an exactly full window and preserves exclusive file creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-log-boundary-"));
  const path = join(directory, "local.jsonl"), maxBytes = 512;
  const event = { type: "full", text: "" };
  const overhead = Buffer.byteLength(`${JSON.stringify({ at: "2000-01-01T00:00:00.000Z", event })}\n`);
  const log = openSessionLog(path, { maxBytes });
  try {
    log.record({ ...event, text: "a".repeat(maxBytes - overhead) });
    assert.equal((await stat(path)).size, maxBytes);
    assert.throws(() => openSessionLog(path), /EEXIST/);
    log.record({ type: "latest" });
    log.close();
    const records = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.length, 1); assert.equal(records[0].event.type, "latest");
    assert.ok((await stat(path)).size <= maxBytes);
  } finally { log.close(); await rm(directory, { recursive: true, force: true }); }
});

test("rolling JSONL scans and copies long UTF-8 records across bounded buffer chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-log-chunks-"));
  const path = join(directory, "local.jsonl"), maxBytes = 256 * 1024;
  const text = "🙂".repeat(24 * 1024); // Each line exceeds the 64 KiB copy buffer.
  const log = openSessionLog(path, { maxBytes });
  try {
    for (let sequence = 0; sequence < 9; sequence++) {
      log.record({ type: "large-fixture", sequence, text });
      const content = await readFile(path, "utf8");
      assert.ok(Buffer.byteLength(content) <= maxBytes);
      const records = content.trim().split("\n").map(line => JSON.parse(line).event);
      assert.deepEqual(records.map(event => event.sequence), sequence === 0 ? [0] : [sequence - 1, sequence]);
      assert.ok(records.every(event => event.text === text));
    }
    log.record({ type: "oversized", text: text.repeat(4) });
    log.record({ type: "stop" });
    log.close();
    const records = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line).event);
    assert.equal(records.at(-2).type, "log-event-omitted"); assert.equal(records.at(-1).type, "stop");
    assert.ok((await stat(path)).size <= maxBytes);
  } finally { log.close(); await rm(directory, { recursive: true, force: true }); }
});

test("reader diagnostics record changed state once, follow restore/reset, and identify the failing stage", () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const events: DiagnosticEvent[] = [];
  const reader = bindGameReader(new DemoGameReader(), emulator, 4, (event) => events.push(event));
  try {
    reader.read(emulator.captureFrame()); reader.read(emulator.captureFrame());
    assert.equal(events.filter((event) => event.event === "state-read").length, 1);
    assert.equal(emulator.frameNumber, 0);
    emulator.advance({ buttons: [], frames: 12 });
    reader.read(emulator.captureFrame());
    const saved = emulator.saveState();
    emulator.advance({ buttons: ["RIGHT"], frames: 4 }); reader.read(emulator.captureFrame());
    emulator.restoreState(saved); reader.reset?.(); reader.read(emulator.captureFrame());
    assert.equal(events.filter((event) => event.event === "state-read").length, 4);
    assert.ok(events.some((event) => event.event === "reset"));
    assert.throws(() => reader.read({ ...emulator.captureFrame(), number: 0 }), /stale/);
    const failure = events.at(-1)!;
    assert.equal(failure.event, "read-failed"); assert.equal(failure.data!.stage, "frame-validation");
    class BrokenReader extends DemoGameReader {
      override availableActions() { return [{ id: "invalid", description: "Fixture invalid input", buttons: ["UNSUPPORTED"], frames: 1, stop: false }]; }
    }
    const broken = bindGameReader(new BrokenReader(), emulator, 4, (event) => events.push(event));
    const frame = emulator.frameNumber;
    assert.throws(() => broken.read(emulator.captureFrame()), /Supported buttons/);
    assert.equal(emulator.frameNumber, frame);
    assert.equal(events.at(-1)!.data!.stage, "validate-actions");
  } finally { emulator.dispose(); }
});

test("provider attempt logs distinguish retries and cancellation without recording transport errors", async () => {
  const events: DiagnosticEvent[] = [];
  const budget = new RequestBudget({ maxRequests: 4, timeoutMs: 1000, intervalMs: 0, retries: 1 }, (event) => events.push(event));
  let attempts = 0;
  await budget.run("Jev", new AbortController().signal, async () => {
    if (++attempts === 1) throw { statusCode: 529, message: "NEVER_RECORD_TRANSPORT_BODY" };
    return "complete";
  }, "typesafe");
  const controller = new AbortController();
  const pending = budget.run("Jev", controller.signal, async () => new Promise(() => {}), "typesafe");
  controller.abort(); await assert.rejects(pending);
  const failures = events.filter((event) => event.event === "request-failed");
  assert.equal(budget.requests, 3); assert.equal(failures.length, 2);
  assert.equal(failures[0]!.data!.statusCode, 529); assert.equal(failures[0]!.data!.retry, true);
  assert.equal(failures[1]!.data!.cancelled, true); assert.equal(failures[1]!.data!.retry, false);
  assert.doesNotMatch(JSON.stringify(events), /NEVER_RECORD_TRANSPORT_BODY/);
});

test("a rejected direct Jev distribution leaves a correlated reader, request, validation, and stop trace", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const events: DiagnosticEvent[] = [];
  const diagnostics = (event: DiagnosticEvent) => { events.push(event); };
  const budget = new RequestBudget({ maxRequests: 4, timeoutMs: 1000, intervalMs: 0, retries: 0 }, diagnostics);
  const reader = bindGameReader(new DemoGameReader(), emulator, 8, diagnostics);
  const decider = createDecisionProvider("typesafe", { environment: { TYPESAFE_API_KEY: "private-key" }, budget, diagnostics,
    fetch: async () => Response.json({ model: "jev-fixture", answers: { next_action: {
      type: "choice", choice: "wait", probabilities: { wait: 0.8, stop: 0 }, confidence: 0.5,
    } }, usage: { input_tokens: 24, output_tokens: 3 }, untrusted: "NEVER_RECORD_PROVIDER_BODY" }),
  });
  const session = new AgentSession(emulator, { mode: "typesafe", visionProvider: "none",
    objectives: { goal: "Read the fixture", constraints: [], milestones: [] }, observer: createStateObserver(reader),
    decider, budget, diagnostics, actionFrames: 8, maxDecisions: 2, maxSeconds: 60,
  });
  try {
    session.tick(1); await session.waitForPending();
    assert.equal(session.snapshot.state, "error"); assert.equal(emulator.frameNumber, 0);
    const names = events.map((event) => `${event.component}:${event.event}`);
    for (const name of ["game-reader:state-read", "agent:decision-requested", "provider:request-completed",
      "jev:action-distribution", "jev:validation-failed", "agent:session-stopped"]) assert.ok(names.includes(name), name);
    const distribution = events.find((event) => event.event === "action-distribution")!;
    assert.equal(distribution.frame, 0); assert.equal(distribution.data!.sum, 0.8);
    assert.equal(distribution.data!.probabilityDecimals, 2);
    assert.equal(events.at(-1)!.data!.stage, "thinking");
    assert.match(session.snapshot.stopReason!, /probabilities sum/);
    assert.doesNotMatch(JSON.stringify(events), /private-key|NEVER_RECORD_PROVIDER_BODY/);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("offline agent diagnostics cover completed and interrupted actions without creating model requests", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const events: DiagnosticEvent[] = [];
  const diagnostics = (event: DiagnosticEvent) => { events.push(event); };
  const budget = new RequestBudget({ maxRequests: 4, timeoutMs: 1000, intervalMs: 0, retries: 0 }, diagnostics);
  emulator.advance({ buttons: [], frames: 12 });
  const session = new AgentSession(emulator, { mode: "mock", visionProvider: "none",
    objectives: { goal: "Inspect controls", constraints: [], milestones: [] },
    observer: createStateObserver(bindGameReader(new DemoGameReader(), emulator, 8, diagnostics)),
    decider: createDecisionProvider("mock", { environment: {}, budget }), budget, diagnostics,
    actionFrames: 8, maxDecisions: 2, maxSeconds: 60,
  });
  try {
    session.tick(1); await session.waitForPending(); session.tick(2); session.pause();
    const interrupted = events.find((event) => event.event === "action-completed")!;
    assert.equal(interrupted.data!.interrupted, true); assert.equal(interrupted.data!.advancedFrames, 2);
    session.resume(); await runAgentHeadless(emulator, session, new AbortController().signal);
    assert.equal(session.snapshot.state, "stopped"); assert.equal(budget.requests, 0);
    assert.ok(events.some((event) => event.event === "action-completed" && event.data!.interrupted === false));
    assert.ok(events.some((event) => event.event === "paused")); assert.ok(events.some((event) => event.event === "resumed"));
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

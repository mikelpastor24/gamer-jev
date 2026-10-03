import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Decision } from "../src/core/agent.js";
import { parseCliOptions } from "../src/config/cli-options.js";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { RequestBudget } from "../src/providers/requests.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { startViewer } from "../src/server/viewer.js";
import { FrameClock } from "../src/server/frame-clock.js";
import { createMockProviders } from "./fixtures/agent-providers.js";

test("viewer pacing delivers the requested high-speed frames and bounds catch-up after stalls", () => {
  for (const speed of [0.5, 1, 8, 32]) {
    const clock = new FrameClock(100, 0);
    let frames = 0;
    for (let time = 8; time <= 200; time += 8) frames += clock.dueFrames(time, speed);
    assert.equal(frames, 20 * speed);
  }
  const stalled = new FrameClock(100, 0);
  const batch = stalled.dueFrames(60_000, 32);
  assert.ok(batch > 3 && batch < 100, "A long stall must not advance thousands of frames in one callback.");
  // Explicit pauses and speed edits reset pacing without catch-up frames.
  stalled.reset(60_000);
  assert.equal(stalled.dueFrames(60_000, 32), 0);
  assert.equal(stalled.dueFrames(60_008, 32), 25);
  assert.throws(() => new FrameClock(0));
});

test("CLI and programmatic viewer startup validate speed including fractional and high-speed values", async () => {
  for (const speed of [0.25, 3.5, 8, 16, 32]) assert.equal(parseCliOptions(["--demo", "--speed", String(speed)]).speed, speed);
  for (const speed of ["", "0", "-1", "NaN", "Infinity", "33", "fast"]) {
    assert.throws(() => parseCliOptions(["--demo", "--speed", speed]));
  }
  const emulator = new GameBoyEmulator(createDemoRom());
  try {
    for (const speed of [0, -1, Infinity, NaN, 33]) {
      await assert.rejects(startViewer(emulator, { port: 0, speed, paused: true, checkpointPath: "unused.json" }), /Emulation speed/);
    }
  } finally { emulator.dispose(); }
});

test("runtime speed edits preserve pause and frames, validate same-origin commands, record changes, and invalidate queued audio", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const records: unknown[] = [];
  const viewer = await startViewer(emulator, { port: 0, speed: 3.5, paused: true, checkpointPath: "unused.json", record: (event) => records.push(event) });
  const post = (body: unknown, origin = viewer.url) => fetch(`${viewer.url}/api/speed`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
  });
  try {
    emulator.advance({ buttons: [], frames: 12 });
    const before = await (await fetch(`${viewer.url}/api/status`)).json();
    assert.equal(before.speed, 3.5);
    const response = await post({ speed: 32 });
    assert.equal(response.status, 200);
    const updated = await response.json();
    assert.equal(updated.speed, 32); assert.equal(updated.paused, true); assert.equal(updated.frame, 12);
    assert.ok(updated.audioEpoch > before.audioEpoch);
    const audio = await fetch(`${viewer.url}/api/audio`);
    assert.equal(audio.headers.get("X-Audio-Speed"), "32");
    assert.equal(Number(audio.headers.get("X-Audio-Epoch")), updated.audioEpoch);
    assert.equal((await audio.arrayBuffer()).byteLength, 0);
    assert.deepEqual(records, [{ type: "emulation-speed", from: 3.5, to: 32, frame: 12 }]);
    for (const data of [{}, [], { speed: null }, { speed: "8" }, { speed: 0 }, { speed: 33 }, { speed: 1, extra: true }]) {
      assert.equal((await post(data)).status, 400);
    }
    assert.equal((await post({ speed: 1 }, "https://example.com")).status, 403);
    const unchanged = await (await fetch(`${viewer.url}/api/status`)).json();
    assert.equal(unchanged.speed, 32); assert.equal(unchanged.frame, 12); assert.equal(records.length, 1);
    await post({ speed: 32 });
    assert.equal(records.length, 1, "An unchanged speed must not create a discontinuity.");
    viewer.setSpeed(4);
    const fromCode = await (await fetch(`${viewer.url}/api/status`)).json();
    assert.equal(fromCode.speed, 4); assert.equal(fromCode.frame, 12); assert.equal(fromCode.paused, true);
    assert.ok(fromCode.audioEpoch > updated.audioEpoch);
    assert.equal(records.length, 2);
    assert.throws(() => viewer.setSpeed(Infinity));
  } finally { await viewer.close(); emulator.dispose(); }
});

test("changing speed during a Jev request leaves its context and signal intact and executes only the bounded chosen action", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  let complete: (decision: Decision) => void = () => {};
  let begin: () => void = () => {};
  const started = new Promise<void>((resolve) => { begin = resolve; });
  let calls = 0;
  const records: unknown[] = [];
  let requestSignal: AbortSignal | undefined;
  const budget = new RequestBudget({ maxRequests: 5, timeoutMs: 2000, intervalMs: 0, retries: 0 });
  const agent = new AgentSession(emulator, { mode: "mock", visionProvider: "none", objectives: { goal: "Wait for the model", constraints: [], milestones: [] },
    observer: createMockProviders().observer, budget, actionFrames: 12, maxDecisions: 1, maxSeconds: 60, record: (event) => records.push(event),
    decider: { async decide(_context, signal) {
      calls++; requestSignal = signal;
      return budget.run("Jev", signal, async () => { begin(); return new Promise((resolve) => { complete = resolve; }); });
    } },
  });
  const viewer = await startViewer(emulator, { agent, port: 0, speed: 1, paused: true, checkpointPath: "unused.json" });
  const post = (path: string, body: unknown = {}) => fetch(`${viewer.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: viewer.url }, body: JSON.stringify(body),
  });
  try {
    await post("/api/resume"); await started;
    const before = agent.inspection;
    const beforeFrame = emulator.frameNumber;
    const response = await post("/api/speed", { speed: 32 });
    assert.equal(response.status, 200); assert.equal((await response.json()).paused, false);
    await delay(30);
    assert.equal(requestSignal!.aborted, false); assert.ok(emulator.frameNumber > beforeFrame);
    assert.equal(calls, 1); assert.equal(budget.requests, 1); assert.deepEqual(agent.inspection, before);
    complete({ actionId: "wait", confidence: 1, probabilities: {}, model: "fixture", usage: { inputTokens: 0, outputTokens: 0 } });
    await agent.waitForPending();
    for (let attempt = 0; attempt < 100 && !agent.terminal; attempt++) await delay(10);
    assert.equal(agent.snapshot.decisions, 1);
    const action = records.find((event) => (event as { type: string }).type === "action") as { fromFrame: number; toFrame: number };
    assert.equal(action.toFrame - action.fromFrame, 12); assert.equal(emulator.frameNumber, action.toFrame);
    assert.equal(calls, 1); assert.match(agent.snapshot.stopReason!, /Decision limit/);
  } finally { await viewer.close(); emulator.dispose(); }
});

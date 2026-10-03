import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Decision, VisualObservation } from "../src/core/agent.js";
import { PNG } from "pngjs";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { startViewer } from "../src/server/viewer.js";
import { createMockProviders } from "./fixtures/agent-providers.js";
import { AgentFailure, RequestBudget } from "../src/providers/requests.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { bindGameReader } from "../src/profiles/registry.js";
import { DemoGameReader } from "../src/profiles/demo.js";
import { createStateObserver } from "../src/observation/state.js";
import { withVision } from "../src/observation/combined.js";

test("the local viewer exposes frames, controls, screenshots, and compatible checkpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-test-"));
  const checkpointPath = join(directory, "checkpoint.json");
  const emulator = new GameBoyEmulator(createDemoRom());
  const viewer = await startViewer(emulator, { port: 0, speed: 1, paused: true, checkpointPath });
  const post = (path: string, body: unknown = {}) => fetch(`${viewer.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: viewer.url }, body: JSON.stringify(body),
  });
  try {
    const page = await fetch(viewer.url);
    assert.match(await page.text(), /lang="en"/);
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.equal((await fetch(`${viewer.url}/viewer.js`)).status, 200);
    assert.equal((await fetch(`${viewer.url}/audio.js`)).status, 200);
    assert.equal((await fetch(`${viewer.url}/inspector.js`)).status, 200);
    assert.equal((await fetch(`${viewer.url}/settings-help.js`)).status, 200);
    assert.equal((await fetch(`${viewer.url}/style.css`)).status, 200);
    assert.deepEqual(await (await fetch(`${viewer.url}/api/jev-exchange`)).json(), { revision: 0, exchange: null });
    const before = await fetch(`${viewer.url}/api/frame`);
    assert.equal((await before.arrayBuffer()).byteLength, 160 * 144 * 4);
    assert.equal((await post("/api/input", { buttons: ["BAD"] })).status, 400);
    assert.equal(emulator.frameNumber, 0);
    assert.equal((await post("/api/step")).status, 200);
    assert.equal(emulator.frameNumber, 1);
    assert.equal((await post("/api/save")).status, 200);
    assert.equal(JSON.parse(await readFile(checkpointPath, "utf8")).frame, 1);
    await post("/api/step");
    assert.equal(emulator.frameNumber, 2);
    assert.equal((await post("/api/load")).status, 200);
    assert.equal(emulator.frameNumber, 1);
    const screenshot = await fetch(`${viewer.url}/api/screenshot`);
    const png = PNG.sync.read(Buffer.from(await screenshot.arrayBuffer()));
    assert.equal(png.width, 160);
    assert.equal(png.height, 144);
    assert.equal((await post("/api/reset")).status, 200);
    assert.equal(emulator.frameNumber, 0);
    const foreign = await fetch(`${viewer.url}/api/reset`, { method: "POST", headers: {
      "Content-Type": "application/json", Origin: "https://example.com",
    }, body: "{}" });
    assert.equal(foreign.status, 403);
    const form = await fetch(`${viewer.url}/api/reset`, { method: "POST", body: "{}" });
    assert.equal(form.status, 403);
    assert.equal((await fetch(`${viewer.url}/missing`)).status, 404);
    const pausedAudio = await fetch(`${viewer.url}/api/audio`);
    assert.equal(pausedAudio.headers.get("X-Audio-Paused"), "true");
    assert.equal((await pausedAudio.arrayBuffer()).byteLength, 0);
    await post("/api/resume");
    emulator.advance({ buttons: [], frames: 5 });
    const audioResponse = await fetch(`${viewer.url}/api/audio`);
    assert.equal(audioResponse.headers.get("X-Audio-Format"), "f32le");
    assert.equal(audioResponse.headers.get("X-Audio-Channels"), "2");
    const samples = await audioResponse.arrayBuffer();
    assert.ok(samples.byteLength > 0 && samples.byteLength % 8 === 0);
    assert.ok(Number.isFinite(new DataView(samples).getFloat32(0, true)));
    const previousEpoch = Number(audioResponse.headers.get("X-Audio-Epoch"));
    await post("/api/pause");
    const stoppedAudio = await fetch(`${viewer.url}/api/audio`);
    assert.equal((await stoppedAudio.arrayBuffer()).byteLength, 0);
    assert.ok(Number(stoppedAudio.headers.get("X-Audio-Epoch")) > previousEpoch);
  } finally {
    await viewer.close();
    emulator.dispose();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual play exposes local memory state and available actions without a decision provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-reader-test-"));
  const emulator = new GameBoyEmulator(createDemoRom());
  const gameState = bindGameReader(new DemoGameReader(), emulator, 24);
  const viewer = await startViewer(emulator, { port: 0, speed: 1, paused: true, checkpointPath: join(directory, "checkpoint.json"), gameState });
  const post = (path: string) => fetch(`${viewer.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: viewer.url }, body: "{}",
  });
  const snapshot = async () => (await fetch(`${viewer.url}/api/game-state`)).json();
  try {
    const initial = await snapshot();
    assert.equal(initial.state.values.phase, "initializing");
    assert.deepEqual(initial.actions.map((action: { id: string }) => action.id), ["wait", "stop"]);
    assert.equal(emulator.frameNumber, 0);
    emulator.advance({ buttons: [], frames: 12 });
    emulator.advance({ buttons: ["RIGHT"], frames: 4 });
    const current = await snapshot();
    assert.equal(current.state.values.phase, "running"); assert.ok(current.state.values.scrollX > 0);
    assert.equal(current.state.frame, 16); assert.equal(emulator.frameNumber, 16);
    await post("/api/save"); await post("/api/reset");
    assert.equal((await snapshot()).state.values.phase, "initializing");
    await post("/api/load"); assert.deepEqual((await snapshot()).state, current.state);
    const status = await (await fetch(`${viewer.url}/api/status`)).json();
    assert.equal(status.agent, null); assert.equal(status.gameReader, "demo");
  } finally {
    await viewer.close(); emulator.dispose();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true });
  }
});

test("the agent viewer exposes decisions, rejects manual input, and stops at its session limit", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const records: unknown[] = [];
  const agent = new AgentSession(emulator, { ...createMockProviders(), mode: "mock",
    objectives: { goal: "Exercise the controller", constraints: [], milestones: [] },
    budget: new RequestBudget({ maxRequests: 10, timeoutMs: 1000, intervalMs: 0, retries: 0 }),
    actionFrames: 4, maxDecisions: 2, maxSeconds: 60, record: (event) => records.push(event),
  });
  const viewer = await startViewer(emulator, { port: 0, speed: 1, paused: true, checkpointPath: "unused-checkpoint.json", agent });
  const post = (path: string, body: unknown = {}) => fetch(`${viewer.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: viewer.url }, body: JSON.stringify(body),
  });
  try {
    const status = await (await fetch(`${viewer.url}/api/status`)).json();
    assert.equal(status.agent.mode, "mock"); assert.equal(status.agent.goal, "Exercise the controller");
    assert.equal(status.agent.state, "paused");
    assert.equal((await post("/api/input", { buttons: ["A"] })).status, 400);
    assert.equal((await post("/api/input", { buttons: [] })).status, 200);
    assert.equal((await post("/api/resume")).status, 200);
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => { if (agent.terminal) { clearInterval(timer); resolve(); } }, 10);
    });
    const actions = records.filter((event) => (event as { type: string }).type === "action") as { fromFrame: number; toFrame: number }[];
    assert.equal(actions.length, 2); assert.ok(actions.every((action) => action.toFrame - action.fromFrame === 8));
    assert.equal(emulator.frameNumber, actions.at(-1)!.toFrame); assert.equal(agent.snapshot.decisions, 2);
    const stopped = await (await fetch(`${viewer.url}/api/status`)).json();
    assert.equal(stopped.audioPaused, true); assert.match(stopped.agent.stopReason, /Decision limit/);
    const exchange = await (await fetch(`${viewer.url}/api/jev-exchange`)).json();
    assert.equal(exchange.exchange.status, "complete");
    assert.equal(exchange.exchange.request.state.objectives.goal, "Exercise the controller");
    assert.equal(exchange.exchange.response.actionId, stopped.agent.action);
    assert.equal(exchange.revision, stopped.agent.exchange.revision);
    assert.equal((await post("/api/resume")).status, 400);
  } finally { await viewer.close(); emulator.dispose(); }
});

test("the viewer keeps frames and PCM audio flowing across delayed vision and Jev responses, then pauses on failure", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  let resolveVision!: (observation: VisualObservation) => void;
  let resolveDecision!: (decision: Decision) => void;
  let rejectDecision!: (error: Error) => void;
  let visionCalls = 0, decisionCalls = 0;
  const records: unknown[] = [];
  const agent = new AgentSession(emulator, { mode: "mock", visionProvider: "mock",
    objectives: { goal: "Keep playback running", constraints: [], milestones: [] },
    budget: new RequestBudget({ maxRequests: 10, timeoutMs: 1000, intervalMs: 0, retries: 0 }),
    actionFrames: 4, maxDecisions: null, maxSeconds: 60, record: (event) => records.push(event),
    observer: withVision(createStateObserver(bindGameReader(new DemoGameReader(), emulator, 4)), { async observe() {
      visionCalls++;
      if (visionCalls === 1) return new Promise((resolve) => { resolveVision = resolve; });
      return { text: "Checkerboard", model: "fixture-vision", usage: { inputTokens: 0, outputTokens: 0 } };
    } }), decider: { decide() {
      decisionCalls++;
      return new Promise((resolve, reject) => { resolveDecision = resolve; rejectDecision = reject; });
    } },
  });
  const viewer = await startViewer(emulator, { agent, port: 0, speed: 4, paused: true, checkpointPath: "unused.json" });
  const status = async () => (await fetch(`${viewer.url}/api/status`)).json();
  const waitUntil = async (predicate: () => boolean) => {
    const deadline = performance.now() + 5000;
    while (!predicate() && performance.now() < deadline) await delay(10);
    assert.ok(predicate(), "Viewer did not reach the expected state.");
  };
  const flowingAudio = async (epoch: number) => {
    const response = await fetch(`${viewer.url}/api/audio`);
    assert.equal(response.headers.get("X-Audio-Paused"), "false");
    assert.equal(Number(response.headers.get("X-Audio-Epoch")), epoch);
    const samples = new Float32Array(await response.arrayBuffer());
    assert.ok(samples.length > 0); assert.ok(samples.every(Number.isFinite));
    assert.ok(samples.some((value) => value !== 0), "The synthetic ROM should provide audible PCM during model work.");
  };
  try {
    const resumed = await fetch(`${viewer.url}/api/resume`, { method: "POST", headers: { "Content-Type": "application/json", Origin: viewer.url }, body: "{}" });
    assert.equal(resumed.status, 200);
    await waitUntil(() => visionCalls === 1 && emulator.frameNumber >= 24);
    const observing = await status();
    assert.equal(observing.agent.state, "observing"); assert.equal(observing.paused, false); assert.equal(observing.audioPaused, false);
    assert.equal(decisionCalls, 0); await flowingAudio(observing.audioEpoch);
    resolveVision({ text: "Checkerboard", model: "fixture-vision", usage: { inputTokens: 0, outputTokens: 0 } });
    await waitUntil(() => decisionCalls === 1 && emulator.frameNumber >= observing.frame + 12);
    const thinking = await status();
    assert.equal(thinking.agent.state, "thinking"); assert.equal(thinking.paused, false); assert.equal(thinking.audioEpoch, observing.audioEpoch);
    assert.equal(visionCalls, 1); await flowingAudio(observing.audioEpoch);
    const firstFrame = agent.inspection.exchange!.frame;
    assert.ok(firstFrame < thinking.frame, "Inspection must retain the request snapshot while the game advances.");
    resolveDecision({ actionId: "wait", confidence: null, probabilities: {}, model: "fixture", usage: { inputTokens: 0, outputTokens: 0 } });
    await waitUntil(() => decisionCalls === 2 && emulator.frameNumber >= thinking.frame + 12);
    const next = await status();
    assert.equal(next.paused, false); assert.equal(next.audioEpoch, observing.audioEpoch); assert.equal(agent.snapshot.decisions, 1);
    assert.equal(visionCalls, 2); await flowingAudio(observing.audioEpoch);
    const action = records.find((event) => (event as { type: string }).type === "action") as { fromFrame: number; toFrame: number };
    assert.equal(action.toFrame - action.fromFrame, 4); assert.ok(action.fromFrame > firstFrame);
    rejectDecision(new AgentFailure("Fixture provider failed.")); await agent.waitForPending();
    await waitUntil(() => agent.terminal);
    for (let attempt = 0; attempt < 100 && !(await status()).paused; attempt++) await delay(10);
    const stopped = await status();
    assert.equal(stopped.paused, true); assert.equal(stopped.agent.state, "error"); assert.ok(stopped.audioEpoch > observing.audioEpoch);
    const audio = await fetch(`${viewer.url}/api/audio`);
    assert.equal(audio.headers.get("X-Audio-Paused"), "true"); assert.equal((await audio.arrayBuffer()).byteLength, 0);
    await delay(40); assert.equal(emulator.frameNumber, stopped.frame); assert.equal(decisionCalls, 2);
  } finally { await viewer.close(); emulator.dispose(); }
});

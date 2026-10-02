import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { startViewer } from "../src/server/viewer.js";
import { createMockProviders } from "./fixtures/agent-providers.js";
import { RequestBudget } from "../src/providers/requests.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { bindGameReader } from "../src/profiles/registry.js";
import { DemoGameReader } from "../src/profiles/demo.js";

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
    assert.equal((await fetch(`${viewer.url}/style.css`)).status, 200);
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
  const agent = new AgentSession(emulator, { ...createMockProviders(), mode: "mock",
    objectives: { goal: "Exercise the controller", constraints: [], milestones: [] },
    budget: new RequestBudget({ maxRequests: 10, timeoutMs: 1000, intervalMs: 0, retries: 0 }),
    actionFrames: 4, maxDecisions: 2, maxSeconds: 60,
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
    assert.equal(emulator.frameNumber, 16); assert.equal(agent.snapshot.decisions, 2);
    const stopped = await (await fetch(`${viewer.url}/api/status`)).json();
    assert.equal(stopped.audioPaused, true); assert.match(stopped.agent.stopReason, /Decision limit/);
    assert.equal((await post("/api/resume")).status, 400);
  } finally { await viewer.close(); emulator.dispose(); }
});

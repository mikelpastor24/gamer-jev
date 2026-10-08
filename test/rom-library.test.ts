import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { createDemoRom } from "../src/demo/rom.js";
import { parseCliOptions } from "../src/config/cli-options.js";
import { createGameRuntime } from "../src/runner/game-runtime.js";
import { LocalRomLibrary, MAX_ROM_BYTES } from "../src/server/rom-library.js";
import { startViewer } from "../src/server/viewer.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { RequestBudget } from "../src/providers/requests.js";
import { createStateObserver } from "../src/observation/state.js";
import { defaultCheckpointPath, saveStateFile } from "../src/emulator/files.js";
import type { Decision, DecisionContext } from "../src/core/agent.js";

async function temporaryDirectory(): Promise<string> { return mkdtemp(join(tmpdir(), "gamer-jev-library-")); }
async function cleanup(directory: string): Promise<void> {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
const manual = () => parseCliOptions(["--demo"]);
const agentOptions = () => parseCliOptions(["--demo", "--agent", "mock", "--vision", "none", "--goal", "Inspect the game", "--unlimited"]);
const decision: Decision = { actionId: "press_right", model: "fixture", confidence: 1, probabilities: {}, usage: { inputTokens: 0, outputTokens: 0 } };

test("the local library lists bounded cartridge files without exposing paths and rejects traversal and links", async () => {
  const directory = await temporaryDirectory();
  const root = join(directory, "roms");
  const library = new LocalRomLibrary(root);
  try {
    assert.deepEqual(await library.list(), []);
    await mkdir(root);
    const bytes = createDemoRom();
    await writeFile(join(root, "My game.gb"), bytes);
    await writeFile(join(root, "Color.GBC"), bytes);
    await writeFile(join(root, "private.txt"), "LOCAL_SECRET");
    await writeFile(join(root, "empty.gb"), "");
    await writeFile(join(root, "large.gb"), new Uint8Array(MAX_ROM_BYTES + 1));
    await mkdir(join(root, "nested.gb"));
    await writeFile(join(directory, "outside.gb"), bytes);
    const listed = await library.list();
    assert.deepEqual(listed.map((entry) => entry.id), ["Color.GBC", "My game.gb"]);
    assert.equal(JSON.stringify(listed).includes(directory), false);
    assert.deepEqual(await library.read("My game.gb"), Buffer.from(bytes));
    for (const id of ["../outside.gb", "..\\outside.gb", join(directory, "outside.gb"), "private.txt", "nested.gb", "large.gb", "missing.gb", 42, null]) {
      await assert.rejects(library.read(id));
    }
    try {
      await symlink(join(directory, "outside.gb"), join(root, "linked.gb"), "file");
      assert.equal((await library.list()).some((entry) => entry.id === "linked.gb"), false);
      await assert.rejects(library.read("linked.gb"));
    } catch (error: unknown) {
      if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  } finally { await cleanup(directory); }
});

test("viewer ROM loading saves the previous game, changes the reader, pauses, and preserves working state on failure", async () => {
  const directory = await temporaryDirectory();
  const options = manual();
  const initial = await createGameRuntime(createDemoRom(), options);
  const bytes = createDemoRom(); bytes[0x7fff] = 1;
  await writeFile(join(directory, "Other game.gb"), bytes);
  await writeFile(join(directory, "Broken.gb"), "invalid cartridge");
  const checkpoint = join(directory, "initial.json");
  const viewer = await startViewer(initial.emulator, { port: 0, speed: 8, paused: true, checkpointPath: checkpoint,
    checkpointDirectory: join(directory, "saves"), romLibrary: new LocalRomLibrary(directory), gameState: initial.gameState,
    dispose: initial.dispose, loadRom: (rom) => createGameRuntime(rom, options, undefined, true) });
  const post = (path: string, body: unknown, origin = viewer.url) => fetch(`${viewer.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
  const status = async () => (await fetch(`${viewer.url}/api/status`)).json();
  try {
    initial.emulator.advance({ buttons: [], frames: 12 });
    const previous = initial.emulator.saveState();
    const catalog = await (await fetch(`${viewer.url}/api/roms`)).json();
    assert.equal(catalog.enabled, true); assert.equal(catalog.entries.length, 2);
    assert.equal((await post("/api/rom", { id: "Other game.gb", gameId: 0 }, "https://example.com")).status, 403);
    assert.equal((await post("/api/rom", { id: "../outside.gb", gameId: 0 })).status, 400);
    assert.equal((await post("/api/rom", { id: "Other game.gb", path: "private", gameId: 0 })).status, 400);
    assert.equal((await status()).rom.sha256, initial.emulator.rom.sha256);
    const changed = await (await post("/api/rom", { id: "Other game.gb", gameId: 0 })).json();
    assert.equal(changed.gameId, 1); assert.equal(changed.gameReader, "emulator");
    assert.equal(changed.paused, true); assert.equal(changed.frame, 0); assert.equal(changed.speed, 8);
    assert.notEqual(changed.rom.sha256, initial.emulator.rom.sha256);
    assert.deepEqual(JSON.parse(await readFile(checkpoint, "utf8")), previous);
    assert.throws(() => initial.emulator.captureFrame(), /disposed/);
    assert.ok(viewer.checkpointPath.startsWith(join(directory, "saves")));
    assert.ok(viewer.checkpointPath.includes(changed.rom.sha256));
    assert.equal((await post("/api/step", { gameId: 0 })).status, 400);
    assert.equal((await post("/api/step", {})).status, 400);
    assert.equal((await post("/api/step", { gameId: 1 })).status, 200);
    assert.equal((await post("/api/rom", { id: "Broken.gb", gameId: 1 })).status, 400);
    assert.equal((await status()).rom.sha256, changed.rom.sha256);
    assert.equal((await status()).frame, 1);
    assert.equal((await fetch(`${viewer.url}/api/frame`)).headers.get("X-Game-Id"), "1");
    assert.equal((await fetch(`${viewer.url}/api/audio`)).headers.get("X-Game-Id"), "1");
    const exchange = await (await fetch(`${viewer.url}/api/jev-exchange`)).json();
    assert.equal(exchange.gameId, 1); assert.equal(exchange.exchange, null);
    assert.equal((await post("/api/save", { gameId: 1 })).status, 200);
    await post("/api/reset", { gameId: 1 }); await post("/api/load", { gameId: 1 });
    assert.equal((await status()).frame, 1);
  } finally { await viewer.close(); viewer.game.dispose(); initial.dispose(); await cleanup(directory); }
});

test("changing ROM cancels pending decisions and carries applied settings into a fresh paused agent session", async () => {
  const directory = await temporaryDirectory();
  const options = agentOptions();
  const initial = await createGameRuntime(createDemoRom(), manual());
  initial.emulator.advance({ buttons: [], frames: 12 });
  await writeFile(join(directory, "Next.gb"), createDemoRom());
  let finish: ((value: Decision) => void) | undefined;
  let pendingSignal: AbortSignal | undefined;
  let oldContext: DecisionContext | undefined;
  const budget = new RequestBudget({ maxRequests: 10, intervalMs: 0, retries: 0, timeoutMs: 1000 });
  const old = new AgentSession(initial.emulator, { mode: "mock", visionProvider: "none", budget,
    objectives: { goal: "Old goal", constraints: [], milestones: [] }, actionFrames: 4, maxDecisions: 3, maxSeconds: 60,
    observer: createStateObserver(initial.gameState), decider: { async decide(context, signal) {
      oldContext = context; pendingSignal = signal;
      return new Promise<Decision>((resolve) => { finish = resolve; });
    } } });
  const settings = { objectives: { goal: "New applied goal", constraints: ["Keep the game local"], milestones: ["Inspect a menu"] },
    maxDecisions: null, maxRequests: null, maxSeconds: null, actionFrames: 3 };
  old.updateSettings(settings, 0);
  const viewer = await startViewer(initial.emulator, { port: 0, speed: 1, paused: true, checkpointPath: join(directory, "old.json"),
    checkpointDirectory: join(directory, "saves"), romLibrary: new LocalRomLibrary(directory), gameState: initial.gameState,
    agent: old, dispose: initial.dispose, loadRom: (rom, next) => createGameRuntime(rom, options, next, true) });
  const post = (path: string, body: unknown) => fetch(`${viewer.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: viewer.url }, body: JSON.stringify(body) });
  try {
    await post("/api/resume", { gameId: 0 });
    for (let attempt = 0; !finish && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(finish); assert.equal(oldContext!.gameState!.source, "demo");
    const result = await (await post("/api/rom", { id: "Next.gb", gameId: 0 })).json();
    assert.equal(pendingSignal!.aborted, true); assert.equal(old.snapshot.state, "stopped");
    assert.equal(result.agent.state, "paused"); assert.equal(result.agent.decisions, 0); assert.equal(result.agent.requests, 0);
    assert.equal(result.agent.goal, settings.objectives.goal); assert.equal(result.agent.maxDecisions, null);
    assert.deepEqual(viewer.game.agent!.copySettings(), settings);
    assert.equal(viewer.game.agent!.inspection.exchange, null);
    finish!(decision); await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(viewer.game.emulator.frameNumber, result.frame); assert.ok(result.frame >= 12);
    assert.equal(viewer.game.agent!.snapshot.decisions, 0);
    const config = await (await fetch(`${viewer.url}/api/agent-settings`)).json();
    assert.equal(config.gameId, 1); assert.equal(config.revision, 0);
    assert.equal((await post("/api/agent-settings", { gameId: 0, revision: 0, settings })).status, 400);
  } finally { old.stop("Test finished."); await viewer.close(); viewer.game.dispose(); initial.dispose(); await cleanup(directory); }
});

test("library ROM changes restore each game's latest checkpoint and reloading preserves unsaved progress", async () => {
  const directory = await temporaryDirectory();
  const checkpointDirectory = join(directory, "saves");
  const options = manual();
  const first = createDemoRom(); const second = createDemoRom(); second[0x7fff] = 3;
  await writeFile(join(directory, "First.gb"), first); await writeFile(join(directory, "Second.gb"), second);
  const initial = await createGameRuntime(first, options);
  const saved = await createGameRuntime(second, options, undefined, true);
  saved.emulator.advance({ buttons: [], frames: 12 });
  saved.emulator.advance({ buttons: ["RIGHT"], frames: 7 });
  const secondFrame = saved.emulator.captureFrame();
  await saveStateFile(saved.emulator, defaultCheckpointPath(saved.emulator, checkpointDirectory));
  saved.dispose();
  const viewer = await startViewer(initial.emulator, { runtime: initial, port: 0, speed: 8, paused: true,
    checkpointPath: defaultCheckpointPath(initial.emulator, checkpointDirectory), checkpointDirectory,
    romLibrary: new LocalRomLibrary(directory), loadRom: (rom) => createGameRuntime(rom, options, undefined, true) });
  const post = (path: string, body: unknown) => fetch(`${viewer.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: viewer.url }, body: JSON.stringify(body) });
  try {
    initial.emulator.advance({ buttons: [], frames: 12 }); initial.emulator.advance({ buttons: ["RIGHT"], frames: 3 });
    const firstFrame = initial.emulator.captureFrame();
    let result = await (await post("/api/rom", { id: "Second.gb", gameId: 0 })).json();
    assert.equal(result.frame, secondFrame.number); assert.equal(result.paused, true); assert.equal(result.speed, 8);
    assert.deepEqual(viewer.game.emulator.captureFrame().pixels, secondFrame.pixels);
    assert.equal((await post("/api/step", { gameId: result.gameId })).status, 200);
    const latestSecond = viewer.game.emulator.captureFrame();
    result = await (await post("/api/rom", { id: "First.gb", gameId: result.gameId })).json();
    assert.equal(result.frame, firstFrame.number); assert.equal(result.paused, true); assert.equal(result.gameReader, "demo");
    assert.deepEqual(viewer.game.emulator.captureFrame().pixels, firstFrame.pixels);
    const state = await (await fetch(`${viewer.url}/api/game-state`)).json();
    assert.equal(state.state.frame, firstFrame.number); assert.equal(state.state.values.phase, "running");
    result = await (await post("/api/rom", { id: "Second.gb", gameId: result.gameId })).json();
    assert.equal(result.frame, latestSecond.number); assert.deepEqual(viewer.game.emulator.captureFrame().pixels, latestSecond.pixels);
    viewer.game.emulator.advance({ buttons: ["LEFT"], frames: 4 });
    const unsaved = viewer.game.emulator.captureFrame();
    result = await (await post("/api/rom", { id: "Second.gb", gameId: result.gameId })).json();
    assert.equal(result.frame, unsaved.number); assert.equal(result.paused, true);
    assert.deepEqual(viewer.game.emulator.captureFrame().pixels, unsaved.pixels);
    assert.equal(JSON.parse(await readFile(viewer.checkpointPath, "utf8")).frame, unsaved.number);
  } finally { await viewer.close(); viewer.game.dispose(); initial.dispose(); await cleanup(directory); }
});

test("invalid saved checkpoints reject ROM changes without replacing the game or overwriting saves", async () => {
  const directory = await temporaryDirectory();
  const checkpointDirectory = join(directory, "saves");
  const options = manual();
  const initial = await createGameRuntime(createDemoRom(), options);
  const bytes = createDemoRom(); bytes[0x7fff] = 5;
  await writeFile(join(directory, "Next.gb"), bytes);
  const saved = await createGameRuntime(bytes, options, undefined, true);
  const target = defaultCheckpointPath(saved.emulator, checkpointDirectory);
  saved.dispose();
  const checkpoint = defaultCheckpointPath(initial.emulator, checkpointDirectory);
  await saveStateFile(initial.emulator, checkpoint);
  const previous = await readFile(checkpoint, "utf8");
  initial.emulator.advance({ buttons: [], frames: 12 });
  const current = initial.emulator.captureFrame();
  await mkdir(dirname(target), { recursive: true });
  let candidate: Awaited<ReturnType<typeof createGameRuntime>> | undefined;
  const viewer = await startViewer(initial.emulator, { runtime: initial, port: 0, speed: 1, paused: true,
    checkpointPath: checkpoint, checkpointDirectory, romLibrary: new LocalRomLibrary(directory),
    async loadRom(rom) { candidate = await createGameRuntime(rom, options, undefined, true); return candidate; } });
  try {
    for (const invalid of ["invalid JSON", previous]) {
      await writeFile(target, invalid);
      const response = await fetch(`${viewer.url}/api/rom`, { method: "POST",
        headers: { "Content-Type": "application/json", Origin: viewer.url }, body: JSON.stringify({ id: "Next.gb", gameId: 0 }) });
      assert.equal(response.status, 400);
      assert.equal(viewer.game.emulator, initial.emulator);
      assert.deepEqual(initial.emulator.captureFrame(), current);
      assert.equal((await (await fetch(`${viewer.url}/api/status`)).json()).paused, true);
      assert.equal(await readFile(checkpoint, "utf8"), previous);
      assert.equal(await readFile(target, "utf8"), invalid);
      assert.throws(() => candidate!.emulator.captureFrame(), /disposed/);
    }
  } finally { await viewer.close(); viewer.game.dispose(); initial.dispose(); await cleanup(directory); }
});

test("a memory-only library load rejects unsupported ROMs while keeping the selected observation strategy and credentials local", async () => {
  const options = agentOptions();
  const settings = { objectives: { goal: "Runtime goal", constraints: [], milestones: [] }, maxDecisions: 2, maxRequests: 3, maxSeconds: 60, actionFrames: 4 };
  const runtime = await createGameRuntime(createDemoRom(), { ...options, profile: "demo" }, settings, true);
  try {
    assert.equal(runtime.gameState.id, "demo"); assert.deepEqual(runtime.agent!.copySettings(), settings);
    const bytes = createDemoRom(); bytes[0x7fff] = 2;
    await assert.rejects(createGameRuntime(bytes, options, settings, true), /compatible game reader/);
    const vision = await createGameRuntime(bytes, { ...options, visionProvider: "mock", observationMode: "vision" }, settings, true);
    try { assert.equal(vision.gameState.id, "emulator"); assert.equal(vision.agent!.snapshot.visionProvider, "mock"); }
    finally { vision.dispose(); }
  } finally { runtime.dispose(); }
});

test("failed checkpoint saves dispose the candidate without replacing the current cartridge", async () => {
  const directory = await temporaryDirectory();
  const options = manual();
  const initial = await createGameRuntime(createDemoRom(), options);
  await writeFile(join(directory, "Next.gb"), createDemoRom());
  await writeFile(join(directory, "blocked"), "not a directory");
  let candidate: Awaited<ReturnType<typeof createGameRuntime>> | undefined;
  const viewer = await startViewer(initial.emulator, { port: 0, speed: 1, paused: true,
    checkpointPath: join(directory, "blocked", "checkpoint.json"), gameState: initial.gameState,
    romLibrary: new LocalRomLibrary(directory), dispose: initial.dispose,
    async loadRom(bytes) { candidate = await createGameRuntime(bytes, options); return candidate; } });
  try {
    const response = await fetch(`${viewer.url}/api/rom`, { method: "POST", headers: { "Content-Type": "application/json", Origin: viewer.url },
      body: JSON.stringify({ id: "Next.gb", gameId: 0 }) });
    assert.equal(response.status, 400);
    assert.equal(viewer.game.emulator, initial.emulator);
    assert.equal(initial.emulator.captureFrame().number, 0);
    assert.throws(() => candidate!.emulator.captureFrame(), /disposed/);
  } finally { await viewer.close(); viewer.game.dispose(); await cleanup(directory); }
});

test("closing during ROM loading cancels the candidate and concurrent cartridge commands are rejected", async () => {
  const directory = await temporaryDirectory();
  const initial = await createGameRuntime(createDemoRom(), manual());
  await writeFile(join(directory, "Next.gb"), createDemoRom());
  let finish: (() => void) | undefined;
  let candidate: Awaited<ReturnType<typeof createGameRuntime>> | undefined;
  const viewer = await startViewer(initial.emulator, { port: 0, speed: 1, paused: true,
    checkpointPath: join(directory, "checkpoint.json"), gameState: initial.gameState,
    romLibrary: new LocalRomLibrary(directory), dispose: initial.dispose, async loadRom(bytes) {
      candidate = await createGameRuntime(bytes, manual());
      await new Promise<void>((resolve) => { finish = resolve; });
      return candidate;
    } });
  const post = (path: string, body: unknown) => fetch(`${viewer.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: viewer.url }, body: JSON.stringify(body) });
  try {
    const pending = post("/api/rom", { id: "Next.gb", gameId: 0 }).catch(() => null);
    for (let attempt = 0; !finish && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(finish);
    const status = await (await fetch(`${viewer.url}/api/status`)).json();
    assert.equal(status.loadingRom, true); assert.equal(status.paused, true);
    assert.equal((await post("/api/resume", { gameId: 0 })).status, 400);
    assert.equal((await post("/api/rom", { id: "Next.gb", gameId: 0 })).status, 400);
    const closed = viewer.close();
    finish!(); await closed; await pending;
    assert.equal(viewer.game.emulator, initial.emulator);
    assert.throws(() => candidate!.emulator.captureFrame(), /disposed/);
  } finally { initial.dispose(); await cleanup(directory); }
});

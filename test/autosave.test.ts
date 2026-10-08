import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Decision } from "../src/core/agent.js";
import { DEFAULT_AUTOSAVE_SETTINGS, parseAutosaveSettings } from "../src/config/autosave.js";
import { parseCliOptions } from "../src/config/cli-options.js";
import { createDemoRom } from "../src/demo/rom.js";
import { defaultCheckpointPath, saveStateFile } from "../src/emulator/files.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { RequestBudget } from "../src/providers/requests.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { createGameRuntime } from "../src/runner/game-runtime.js";
import { CheckpointAutosave } from "../src/server/checkpoint-autosave.js";
import { LocalRomLibrary } from "../src/server/rom-library.js";
import { startViewer } from "../src/server/viewer.js";
import { createMockProviders } from "./fixtures/agent-providers.js";

const enabled = { enabled: true, decisionInterval: 2, manualSeconds: 1 };
const decision: Decision = { actionId: "wait", confidence: 1, probabilities: {}, model: "fixture",
  usage: { inputTokens: 0, outputTokens: 0 } };
async function cleanup(directory: string): Promise<void> {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
async function waitUntil(predicate: () => Promise<boolean>, name: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(15); }
  assert.fail(`Timed out waiting for ${name}.`);
}

test("autosave validates whole settings and revisions before changing an active schedule", () => {
  const scheduler = new CheckpointAutosave();
  assert.deepEqual(scheduler.status.settings, DEFAULT_AUTOSAVE_SETTINGS);
  for (const settings of [null, [], {}, { ...enabled, extra: true }, { ...enabled, enabled: "yes" },
    ...[0, -1, 1.5, NaN, Infinity, 10_001, "2"].map(decisionInterval => ({ ...enabled, decisionInterval })),
    ...[0, -1, 1.5, NaN, Infinity, 86_401, "60"].map(manualSeconds => ({ ...enabled, manualSeconds }))]) {
    assert.throws(() => scheduler.configure(settings, 0, 0));
  }
  assert.deepEqual(scheduler.status.settings, DEFAULT_AUTOSAVE_SETTINGS); assert.equal(scheduler.status.revision, 0);
  scheduler.configure(enabled, 0, 7, 0);
  assert.throws(() => scheduler.configure({ ...enabled, enabled: false }, 0, 7), /another window/);
  assert.deepEqual(scheduler.status.settings, enabled); assert.equal(scheduler.status.revision, 1);
  assert.deepEqual(parseAutosaveSettings({ enabled: false, decisionInterval: 10_000, manualSeconds: 86_400 }),
    { enabled: false, decisionInterval: 10_000, manualSeconds: 86_400 });
});

test("agent autosave counts new decisions and defers a due checkpoint until the current input finishes", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const saves: number[] = [];
  const scheduler = new CheckpointAutosave(enabled, async game => { saves.push(game.frameNumber); });
  scheduler.reset(7, 0);
  const context = { emulator, checkpointPath: "unused.json", decisions: 7, paused: false, blocked: false };
  try {
    scheduler.tick({ ...context, decisions: 8 }, 1000); assert.equal(saves.length, 0);
    scheduler.tick({ ...context, decisions: 8 }, 90_000); assert.equal(saves.length, 0, "Elapsed time does not trigger agent saves.");
    emulator.advance({ buttons: [], frames: 12 });
    scheduler.tick({ ...context, decisions: 9, blocked: true }, 90_010); assert.equal(saves.length, 0);
    emulator.advance({ buttons: ["RIGHT"], frames: 2 });
    scheduler.tick({ ...context, decisions: 9 }, 90_020); await scheduler.flush();
    assert.deepEqual(saves, [14]);
    scheduler.tick({ ...context, decisions: 9, paused: true }, 95_000); assert.deepEqual(saves, [14]);
    scheduler.tick({ ...context, decisions: 11, paused: true }, 95_010); await scheduler.flush();
    assert.deepEqual(saves, [14, 14], "The final due decision may be saved after the agent stops.");
  } finally { emulator.dispose(); }
});

test("manual autosave uses active wall time, excludes pauses, and ignores decision counts", async () => {
  const emulator = new GameBoyEmulator(createDemoRom()); let saves = 0;
  const scheduler = new CheckpointAutosave(enabled, async () => { saves++; });
  scheduler.reset(null, 0);
  const context = { emulator, checkpointPath: "unused.json", decisions: null, paused: false, blocked: false };
  try {
    scheduler.tick(context, 0); scheduler.tick(context, 600); assert.equal(saves, 0);
    scheduler.tick({ ...context, paused: true }, 600);
    scheduler.tick({ ...context, paused: true }, 10_000); assert.equal(saves, 0);
    scheduler.tick(context, 10_000); scheduler.tick(context, 10_399); assert.equal(saves, 0);
    scheduler.tick(context, 10_400); await scheduler.flush(); assert.equal(saves, 1);
    scheduler.tick(context, 11_399); assert.equal(saves, 1);
    scheduler.tick(context, 11_400); await scheduler.flush(); assert.equal(saves, 2);
  } finally { emulator.dispose(); }
});

test("autosave keeps a single write in flight and disabling it prevents further writes", async () => {
  const emulator = new GameBoyEmulator(createDemoRom()); const paths: string[] = [];
  let finish: (() => void) | undefined;
  const scheduler = new CheckpointAutosave(enabled, async (_game, path) => {
    paths.push(path); await new Promise<void>(resolve => { finish = resolve; });
  });
  scheduler.reset(0, 0);
  const context = { emulator, checkpointPath: "first.json", decisions: 2, paused: false, blocked: false };
  try {
    scheduler.tick(context, 10); assert.equal(scheduler.status.saving, true);
    scheduler.tick({ ...context, decisions: 4 }, 20); assert.deepEqual(paths, ["first.json"]);
    let flushed = false; const waiting = scheduler.flush().then(() => { flushed = true; });
    await Promise.resolve(); assert.equal(flushed, false);
    finish!(); await waiting; assert.equal(scheduler.status.saving, false);
    scheduler.reset(0, 30, true); assert.equal(scheduler.status.lastSavedFrame, null);
    scheduler.tick({ ...context, checkpointPath: "second.json", blocked: true }, 40);
    assert.deepEqual(paths, ["first.json"]);
    scheduler.tick({ ...context, checkpointPath: "second.json" }, 50);
    assert.deepEqual(paths, ["first.json", "second.json"]);
    scheduler.configure({ ...enabled, enabled: false }, 0, 2, 60);
    finish!(); await scheduler.flush();
    scheduler.tick({ ...context, decisions: 100 }, 70); assert.equal(paths.length, 2);
    assert.equal(scheduler.status.settings.enabled, false);
  } finally { finish?.(); await scheduler.flush(); emulator.dispose(); }
});

test("play mode, save, and timeline changes start a new interval while cartridge changes retain settings", async () => {
  const emulator = new GameBoyEmulator(createDemoRom()); let saves = 0;
  const scheduler = new CheckpointAutosave(enabled, async () => { saves++; });
  scheduler.reset(10, 0);
  const context = { emulator, checkpointPath: "unused.json", decisions: 11 as number | null, paused: false, blocked: false };
  try {
    scheduler.tick(context, 1); assert.equal(saves, 0);
    scheduler.tick({ ...context, decisions: null }, 100);
    scheduler.tick({ ...context, decisions: null }, 1100); await scheduler.flush(); assert.equal(saves, 1);
    scheduler.tick({ ...context, decisions: 20 }, 1200);
    scheduler.tick({ ...context, decisions: 21 }, 1300); assert.equal(saves, 1);
    scheduler.reset(21, 1400);
    scheduler.tick({ ...context, decisions: 22 }, 1500); assert.equal(saves, 1);
    scheduler.tick({ ...context, decisions: 23 }, 1600); await scheduler.flush(); assert.equal(saves, 2);
    scheduler.reset(0, 1700, true);
    assert.equal(scheduler.status.lastSavedAt, null); assert.deepEqual(scheduler.status.settings, enabled);
    scheduler.tick({ ...context, decisions: 1 }, 1800); assert.equal(saves, 2);
  } finally { emulator.dispose(); }
});

test("autosave failures are reported without stopping gameplay or retrying every tick", async () => {
  const emulator = new GameBoyEmulator(createDemoRom()); let attempts = 0;
  const events: unknown[] = [];
  const scheduler = new CheckpointAutosave(enabled, async () => { if (++attempts === 1) throw new Error("Disk unavailable"); });
  scheduler.reset(0, 0);
  const context = { emulator, checkpointPath: "unused.json", decisions: 2, paused: false, blocked: false,
    record: (event: unknown) => events.push(event) };
  try {
    scheduler.tick(context, 10); await scheduler.flush(); assert.equal(scheduler.status.error, "Disk unavailable");
    assert.equal(scheduler.status.saving, false); assert.equal(scheduler.status.settings.enabled, true);
    emulator.advance({ buttons: [], frames: 12 });
    scheduler.tick(context, 100); scheduler.tick({ ...context, decisions: 3 }, 200); assert.equal(attempts, 1);
    scheduler.tick({ ...context, decisions: 4 }, 300); await scheduler.flush();
    assert.equal(attempts, 2); assert.equal(scheduler.status.error, null); assert.equal(scheduler.status.lastSavedFrame, 12);
    assert.deepEqual(events, [{ type: "checkpoint-autosave-failed", trigger: "decisions", frame: 0, reason: "Disk unavailable" },
      { type: "checkpoint-autosave", trigger: "decisions", frame: 12, decisions: 4 }]);
  } finally { emulator.dispose(); }
});

test("checkpoint writes replace complete files and clean temporary files after a failed replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-autosave-"));
  const emulator = new GameBoyEmulator(createDemoRom()); const checkpoint = join(directory, "checkpoint.json");
  try {
    await saveStateFile(emulator, checkpoint);
    emulator.advance({ buttons: [], frames: 12 }); await saveStateFile(emulator, checkpoint);
    assert.equal(JSON.parse(await readFile(checkpoint, "utf8")).frame, 12);
    const protectedDirectory = join(directory, "protected"); await mkdir(protectedDirectory);
    const previous = await readFile(checkpoint, "utf8"); await writeFile(join(protectedDirectory, "checkpoint.json"), previous);
    await assert.rejects(saveStateFile(emulator, protectedDirectory));
    assert.equal(await readFile(join(protectedDirectory, "checkpoint.json"), "utf8"), previous);
    assert.deepEqual((await readdir(directory)).sort(), ["checkpoint.json", "protected"]);
    const restored = new GameBoyEmulator(createDemoRom());
    try { restored.restoreState(JSON.parse(await readFile(checkpoint, "utf8"))); assert.equal(restored.frameNumber, 12); }
    finally { restored.dispose(); }
  } finally { emulator.dispose(); await cleanup(directory); }
});

test("the viewer saves decision intervals with immediate mock responses while pending Jev work keeps running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-autosave-"));
  const emulator = new GameBoyEmulator(createDemoRom()); const checkpoint = join(directory, "checkpoint.json");
  let calls = 0; let pendingSignal: AbortSignal | undefined; let finish: ((value: Decision) => void) | undefined;
  const events: unknown[] = [];
  const budget = new RequestBudget({ maxRequests: 10, timeoutMs: 10_000, intervalMs: 0, retries: 0 });
  const agent = new AgentSession(emulator, { mode: "mock", visionProvider: "none", observer: createMockProviders().observer,
    objectives: { goal: "Exercise autosave", constraints: [], milestones: [] }, budget, actionFrames: 1, maxDecisions: 10, maxSeconds: 60,
    decider: { async decide(_context, signal) {
      return budget.run("Jev", signal, async () => {
        if (++calls <= 4) return decision;
        pendingSignal = signal; return new Promise<Decision>(resolve => { finish = resolve; });
      });
    } } });
  const viewer = await startViewer(emulator, { agent, port: 0, speed: 8, paused: true, checkpointPath: checkpoint,
    record: event => events.push(event) });
  const post = (path: string, body: unknown) => fetch(`${viewer.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: viewer.url }, body: JSON.stringify(body) });
  const status = async () => (await fetch(`${viewer.url}/api/status`)).json();
  try {
    const applied = await (await post("/api/autosave-settings", { settings: enabled, revision: 0, gameId: 0 })).json();
    assert.equal(applied.paused, true); assert.deepEqual(applied.autosave.settings, enabled);
    await post("/api/resume", {});
    await waitUntil(async () => {
      const current = await status();
      return calls === 5 && !current.autosave.saving && events.filter(event => (event as { type: string }).type === "checkpoint-autosave").length === 2;
    }, "two completed decision autosaves and a pending request");
    const current = await status(); const saved = JSON.parse(await readFile(checkpoint, "utf8"));
    assert.equal(current.paused, false); assert.equal(current.agent.decisions, 4); assert.equal(current.agent.requests, 5);
    assert.equal(current.agent.state, "thinking"); assert.equal(pendingSignal!.aborted, false);
    assert.equal(saved.frame, current.autosave.lastSavedFrame); assert.equal(saved.romSha256, emulator.rom.sha256);
    const before = emulator.frameNumber;
    const disabled = await (await post("/api/autosave-settings", { settings: { ...enabled, enabled: false }, revision: 1, gameId: 0 })).json();
    assert.equal(disabled.paused, false); assert.equal(pendingSignal!.aborted, false);
    await delay(40); assert.ok(emulator.frameNumber > before); assert.equal(calls, 5);
    assert.equal((await post("/api/autosave-settings", { settings: enabled, revision: 1, gameId: 0 })).status, 400);
  } finally { await viewer.close(); finish?.(decision); await agent.waitForPending(); emulator.dispose(); await cleanup(directory); }
});

test("manual viewer autosave is configurable, preserves ROM settings, and saves the correct cartridge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-autosave-"));
  const options = parseCliOptions(["--demo"]);
  const initial = await createGameRuntime(createDemoRom(), options, undefined, false, { environment: {} });
  const bytes = createDemoRom(); bytes[0x7fff] = 6; await writeFile(join(directory, "Next.gb"), bytes);
  const checkpointDirectory = join(directory, "saves");
  const viewer = await startViewer(initial.emulator, { runtime: initial, port: 0, speed: 8, paused: true,
    checkpointPath: defaultCheckpointPath(initial.emulator, checkpointDirectory), checkpointDirectory,
    romLibrary: new LocalRomLibrary(directory), loadRom: rom => createGameRuntime(rom, options, undefined, true, { environment: {} }) });
  const post = (path: string, body: unknown, origin = viewer.url) => fetch(`${viewer.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
  const status = async () => (await fetch(`${viewer.url}/api/status`)).json();
  try {
    const page = await (await fetch(viewer.url)).text(); assert.match(page, /id="autosave-enabled"/);
    assert.equal((await fetch(`${viewer.url}/autosave.js`)).status, 200);
    assert.equal((await post("/api/autosave-settings", { settings: enabled, revision: 0, gameId: 0 }, "https://example.com")).status, 403);
    for (const body of [{ settings: { ...enabled, manualSeconds: 0 }, revision: 0, gameId: 0 },
      { settings: enabled, revision: 0, gameId: 0, extra: true }, { settings: enabled, revision: 0 }]) {
      assert.equal((await post("/api/autosave-settings", body)).status, 400);
    }
    assert.equal((await status()).autosave.revision, 0);
    const applied = await (await post("/api/autosave-settings", { settings: enabled, revision: 0, gameId: 0 })).json();
    assert.equal(applied.paused, true); assert.deepEqual(applied.autosave.settings, enabled);
    await delay(50); assert.equal((await status()).autosave.lastSavedAt, null);
    await post("/api/resume", {});
    await waitUntil(async () => (await status()).autosave.lastSavedAt !== null, "manual autosave");
    await post("/api/pause", {});
    await waitUntil(async () => !(await status()).autosave.saving, "the pending manual autosave to finish");
    const current = await status(); const saved = JSON.parse(await readFile(viewer.checkpointPath, "utf8"));
    assert.equal(saved.romSha256, initial.emulator.rom.sha256); assert.equal(saved.frame, current.autosave.lastSavedFrame);
    assert.ok(saved.frame > 0); assert.equal(current.error, null);
    const changed = await (await post("/api/rom", { id: "Next.gb", gameId: 0 })).json();
    assert.equal(changed.paused, true); assert.deepEqual(changed.autosave.settings, enabled);
    assert.equal(changed.autosave.lastSavedAt, null); assert.equal(changed.autosave.lastSavedFrame, null);
    assert.equal((await post("/api/autosave-settings", { settings: enabled, revision: 1, gameId: 0 })).status, 400);
    await post("/api/resume", { gameId: changed.gameId });
    await waitUntil(async () => (await status()).autosave.lastSavedAt !== null, "new cartridge autosave");
    await post("/api/pause", { gameId: changed.gameId });
    const nextSaved = JSON.parse(await readFile(viewer.checkpointPath, "utf8"));
    assert.equal(nextSaved.romSha256, changed.rom.sha256); assert.notEqual(nextSaved.romSha256, initial.emulator.rom.sha256);
  } finally { await viewer.close(); viewer.game.dispose(); initial.dispose(); await cleanup(directory); }
});

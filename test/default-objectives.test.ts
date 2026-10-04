import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { Objectives } from "../src/core/agent.js";
import { parseCliOptions } from "../src/config/cli-options.js";
import { createDemoRom } from "../src/demo/rom.js";
import { GameReaderRegistry } from "../src/profiles/registry.js";
import { parseJsonGameReader } from "../src/profiles/json.js";
import { createGameRuntime } from "../src/runner/game-runtime.js";
import { startViewer } from "../src/server/viewer.js";
import { LocalRomLibrary } from "../src/server/rom-library.js";

const objectives = (name: string): Objectives => ({ goal: `Complete ${name}`, constraints: ["Read the instructions"], milestones: [`Leave ${name}'s starting room`] });
function fixtures() {
  const first = createDemoRom(), second = createDemoRom(); second[0x134] = 88;
  const readers = new GameReaderRegistry();
  for (const [index, rom] of [first, second].entries()) {
    const descriptor = { id: `fixture-${index}`, name: `Fixture ${index}`, consoleId: "game-boy", romSha256: [createHash("sha256").update(rom).digest("hex")] };
    readers.register({ descriptor, create: () => {
      let supplied = objectives(String(index));
      return { descriptor, defaultObjectives: supplied, setObjectives: value => { supplied = value; },
        readState: () => ({ values: { phase: "running", suppliedGoal: supplied.goal }, descriptions: {} }), availableActions: (_state, actions) => actions };
    } });
  }
  return { first, second, readers };
}

test("JSON readers validate optional default objectives and reject malformed guidance", async () => {
  const json = JSON.parse(await readFile(new URL("../examples/demo-profile.json", import.meta.url), "utf8"));
  assert.equal(parseJsonGameReader(json).defaultObjectives, undefined);
  assert.deepEqual(parseJsonGameReader({ ...json, defaultObjectives: objectives("demo") }).defaultObjectives, objectives("demo"));
  for (const invalid of [{ goal: " " }, { goal: "Test", milestones: Array(17).fill("Too many") }, { goal: "Test", constraints: [123] }]) {
    assert.throws(() => parseJsonGameReader({ ...json, defaultObjectives: invalid }), /Objectives/);
  }
});

test("manual sessions preload reader objectives, explicit CLI objectives take precedence, and custom edits survive model changes", async () => {
  const { first, readers } = fixtures();
  const options = parseCliOptions([]);
  const runtime = await createGameRuntime(first, options, undefined, false, { readers, environment: {} });
  try {
    const player = runtime.player!;
    assert.equal(runtime.agent, undefined); assert.equal(runtime.emulator.frameNumber, 0);
    assert.deepEqual(player.configuration.settings!.objectives, objectives("0"));
    assert.equal(runtime.gameState.read(runtime.emulator.captureFrame()).state.values.suppliedGoal, objectives("0").goal);
    assert.equal(player.configuration.objectiveSource, "reader");
    const custom = { ...player.copySettings()!, objectives: objectives("custom") };
    player.configure(player.copySelection(), custom, player.configuration.revision);
    assert.equal(runtime.gameState.read(runtime.emulator.captureFrame()).state.values.suppliedGoal, custom.objectives.goal);
    assert.equal(player.copyObjectiveSource(), "user");
    const before = player.configuration.revision;
    assert.throws(() => player.configure({ ...player.copySelection(), mode: "agent" }, custom, before - 1), /another window/);
    player.configure({ ...player.copySelection(), mode: "agent" }, null, before);
    assert.deepEqual(runtime.agent!.copySettings().objectives, custom.objectives);
    assert.equal(runtime.agent!.snapshot.state, "paused"); assert.equal(runtime.agent!.snapshot.requests, 0);
    const blank = { ...custom, objectives: { goal: "", constraints: [], milestones: [] } };
    player.configure({ ...player.copySelection(), mode: "manual" }, blank, player.configuration.revision);
    assert.equal(runtime.gameState.read(runtime.emulator.captureFrame()).state.values.suppliedGoal, "");
    assert.equal(runtime.agent, undefined);
    assert.throws(() => player.configure({ ...player.copySelection(), mode: "agent" }, blank, player.configuration.revision), /Objectives/);
  } finally { runtime.dispose(); }
  const liveOptions = parseCliOptions(["--demo", "--agent", "mock", "--vision", "none", "--goal", "My own goal"]);
  const explicit = await createGameRuntime(first, liveOptions, undefined, false, { readers, environment: {} });
  try { assert.equal(explicit.agent!.snapshot.goal, "My own goal"); assert.deepEqual(explicit.agent!.copySettings().objectives.milestones, []); }
  finally { explicit.dispose(); }
  const automatic = await createGameRuntime(first, { ...liveOptions, goal: undefined }, undefined, false, { readers, environment: {} });
  try { assert.deepEqual(automatic.agent!.copySettings().objectives, objectives("0")); }
  finally { automatic.dispose(); }
  await assert.rejects(createGameRuntime(createDemoRom(), { ...liveOptions, goal: undefined }, undefined, false, { environment: {} }), /no default objectives/);
});

test("ROM loading refreshes untouched reader suggestions, preserves custom objectives and ceilings, and rejects stale edits", async () => {
  const { first, second, readers } = fixtures();
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-objectives-"));
  const options = parseCliOptions([]);
  const initial = await createGameRuntime(first, options, undefined, false, { readers, environment: {} });
  await writeFile(join(directory, "First.gb"), first); await writeFile(join(directory, "Second.gb"), second);
  const viewer = await startViewer(initial.emulator, { runtime: initial, port: 0, speed: 1, paused: true,
    checkpointPath: join(directory, "initial.json"), checkpointDirectory: join(directory, "saves"), romLibrary: new LocalRomLibrary(directory),
    loadRom: (rom, settings, selection, objectiveSource) => createGameRuntime(rom, options, settings, true,
      { readers, environment: {}, ...(selection ? { selection } : {}), ...(objectiveSource ? { objectiveSource } : {}) }) });
  const get = async (path: string) => (await fetch(`${viewer.url}${path}`)).json();
  const post = (path: string, data: unknown) => fetch(`${viewer.url}${path}`, { method: "POST", headers: { Origin: viewer.url, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  try {
    const initialConfig = await get("/api/player-settings");
    assert.deepEqual(initialConfig.defaultObjectives, objectives("0"));
    const switched = await (await post("/api/rom", { id: "Second.gb", gameId: initialConfig.gameId })).json();
    let current = await get("/api/player-settings");
    assert.deepEqual(current.settings.objectives, objectives("1")); assert.equal(current.objectiveSource, "reader");
    assert.equal(switched.paused, true);
    assert.equal((await post("/api/player-settings", { selection: current.selection, settings: current.settings, revision: current.revision, gameId: initialConfig.gameId })).status, 400);
    const custom = { ...current.settings, objectives: objectives("user"), maxDecisions: null, maxRequests: 88 };
    const applied = await (await post("/api/player-settings", { selection: current.selection, settings: custom, revision: current.revision, gameId: current.gameId })).json();
    await post("/api/rom", { id: "First.gb", gameId: applied.gameId }); current = await get("/api/player-settings");
    assert.deepEqual(current.settings, custom); assert.equal(current.objectiveSource, "user");
    assert.deepEqual(current.defaultObjectives, objectives("0"));
    // Restoring profile guidance is a normal validated settings edit; it keeps session ceilings.
    const restored = { ...current.settings, objectives: current.defaultObjectives };
    const result = await post("/api/player-settings", { selection: current.selection, settings: restored, revision: current.revision, gameId: current.gameId });
    assert.equal(result.status, 200); current = await get("/api/player-settings");
    assert.equal(current.objectiveSource, "reader"); assert.equal(current.settings.maxRequests, 88);
  } finally {
    await viewer.close(); viewer.game.dispose(); initial.dispose();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true });
  }
});

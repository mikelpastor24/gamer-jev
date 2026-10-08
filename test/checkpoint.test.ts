import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { parseCliOptions } from "../src/config/cli-options.js";
import { createDemoRom } from "../src/demo/rom.js";
import { defaultCheckpointPath, loadCheckpointIfPresent, saveStateFile } from "../src/emulator/files.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { createGameRuntime } from "../src/runner/game-runtime.js";

async function cleanup(directory: string): Promise<void> {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true });
}

test("optional checkpoints start fresh when missing and restore only compatible saved state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-checkpoint-"));
  const emulator = new GameBoyEmulator(createDemoRom());
  const bytes = createDemoRom(); bytes[0x7fff] = 4;
  const other = new GameBoyEmulator(bytes);
  const checkpoint = defaultCheckpointPath(emulator, directory);
  try {
    assert.equal(defaultCheckpointPath(emulator), join("saves", "game-boy", emulator.rom.sha256, "checkpoint.json"));
    assert.notEqual(defaultCheckpointPath(other, directory), checkpoint);
    assert.equal(await loadCheckpointIfPresent(emulator, checkpoint), false); assert.equal(emulator.frameNumber, 0);
    emulator.advance({ buttons: [], frames: 12 }); emulator.advance({ buttons: ["RIGHT"], frames: 7 });
    const frame = emulator.captureFrame(); const memory = emulator.readMemory(0xff42, 2);
    await saveStateFile(emulator, checkpoint);
    emulator.reset();
    assert.equal(await loadCheckpointIfPresent(emulator, checkpoint), true);
    assert.deepEqual(emulator.captureFrame(), frame); assert.deepEqual(emulator.readMemory(0xff42, 2), memory);
    await assert.rejects(loadCheckpointIfPresent(other, checkpoint), /incompatible/);
    assert.equal(other.frameNumber, 0);
    await writeFile(checkpoint, "invalid JSON");
    await assert.rejects(loadCheckpointIfPresent(emulator, checkpoint), SyntaxError);
    assert.deepEqual(emulator.captureFrame(), frame);
    assert.equal(await readFile(checkpoint, "utf8"), "invalid JSON");
  } finally { emulator.dispose(); other.dispose(); await cleanup(directory); }
});

test("interactive startup restores its save destination before readers and a fresh agent session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-checkpoint-"));
  const checkpoint = join(directory, "session.json");
  const rom = createDemoRom(); const emulator = new GameBoyEmulator(rom);
  try {
    const options = parseCliOptions(["--demo", "--save", checkpoint]);
    const fresh = await createGameRuntime(rom, options, undefined, false, { resumeCheckpoint: true, environment: {} });
    try { assert.equal(fresh.emulator.frameNumber, 0); } finally { fresh.dispose(); }
    emulator.advance({ buttons: [], frames: 12 }); emulator.advance({ buttons: ["RIGHT"], frames: 7 });
    const frame = emulator.captureFrame(); const scrollX = emulator.readMemory(0xff43, 1)[0];
    await saveStateFile(emulator, checkpoint);
    const resumed = await createGameRuntime(rom, options, undefined, false, { resumeCheckpoint: true, environment: {} });
    try {
      assert.deepEqual(resumed.emulator.captureFrame(), frame);
      const state = resumed.gameState.read(frame).state;
      assert.equal(state.values.phase, "running"); assert.equal(state.values.scrollX, scrollX);
    } finally { resumed.dispose(); }
    const agentOptions = parseCliOptions(["--demo", "--agent", "mock", "--vision", "none", "--goal", "Inspect the game", "--save", checkpoint]);
    const agent = await createGameRuntime(rom, agentOptions, undefined, false, { resumeCheckpoint: true, environment: {} });
    try {
      assert.equal(agent.emulator.frameNumber, frame.number);
      assert.equal(agent.agent!.snapshot.decisions, 0); assert.equal(agent.agent!.snapshot.requests, 0);
      assert.equal(agent.agent!.inspection.exchange, null);
      assert.equal(agent.gameState.read(frame).state.values.scrollX, scrollX);
    } finally { agent.dispose(); }
    await writeFile(checkpoint, "invalid JSON");
    await assert.rejects(createGameRuntime(rom, options, undefined, false, { resumeCheckpoint: true, environment: {} }), SyntaxError);
    assert.equal(await readFile(checkpoint, "utf8"), "invalid JSON");
  } finally { emulator.dispose(); await cleanup(directory); }
});

test("explicit loads take precedence and headless runs do not automatically resume a save destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-checkpoint-"));
  const checkpoint = join(directory, "session.json"); const explicit = join(directory, "explicit.json");
  const rom = createDemoRom(); const emulator = new GameBoyEmulator(rom);
  try {
    emulator.advance({ buttons: [], frames: 12 }); await saveStateFile(emulator, checkpoint);
    emulator.advance({ buttons: ["RIGHT"], frames: 7 }); await saveStateFile(emulator, explicit);
    for (const headless of [false, true]) {
      const options = parseCliOptions(["--demo", "--save", checkpoint, "--load", explicit, ...(headless ? ["--headless"] : [])]);
      const runtime = await createGameRuntime(rom, options, undefined, false, { resumeCheckpoint: true, environment: {} });
      try { assert.equal(runtime.emulator.frameNumber, 19); } finally { runtime.dispose(); }
    }
    const options = parseCliOptions(["--demo", "--headless", "--save", checkpoint]);
    const runtime = await createGameRuntime(rom, options, undefined, false, { resumeCheckpoint: true, environment: {} });
    try { assert.equal(runtime.emulator.frameNumber, 0); } finally { runtime.dispose(); }
  } finally { emulator.dispose(); await cleanup(directory); }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCliOptions } from "../src/config/cli-options.js";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { runHeadless } from "../src/runner/headless.js";

test("CLI accepts local ROM paths with spaces and normalizes button names", () => {
  const options = parseCliOptions(["--rom", "roms/my game.gb", "--headless", "--frames", "12", "--buttons", "right,a"]);
  assert.equal(options.romPath, "roms/my game.gb");
  assert.equal(options.frames, 12);
  assert.deepEqual(options.buttons, ["RIGHT", "A"]);
});

test("CLI starts a paused manual launcher without arguments and still supports explicit cartridges", () => {
  const options = parseCliOptions([]);
  assert.equal(options.launcher, true); assert.equal(options.demo, true); assert.equal(options.paused, true);
  assert.equal(options.agent, undefined); assert.equal(options.visionProvider, "none");
  assert.equal(parseCliOptions(["--rom", "game.gb"]).launcher, false);
  assert.equal(parseCliOptions(["--demo"]).paused, false);
});

test("CLI rejects ambiguous sources, ignored options, and unbounded manual headless execution", () => {
  for (const args of [["--headless"], ["--rom", " "], ["--demo", "--rom", "rom.gb"], ["--demo", "--frames", "10"],
    ["--demo", "--headless", "--frames", "0"], ["--demo", "--speed", "Infinity"],
    ["--demo", "--port", "0"], ["--demo", "--headless", "--paused"], ["--demo", "--unknown"]]) {
    assert.throws(() => parseCliOptions(args));
  }
  assert.equal(parseCliOptions(["--help"]).help, true);
  assert.equal(parseCliOptions(["--list-consoles"]).listConsoles, true);
});

test("headless runs stop at the requested limit and honor interruption", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  try {
    assert.equal(await runHeadless(emulator, 13), 13);
    assert.equal(emulator.frameNumber, 13);
    const controller = new AbortController();
    controller.abort();
    assert.equal(await runHeadless(emulator, 100, [], controller.signal), 0);
    assert.equal(emulator.frameNumber, 13);
    await assert.rejects(runHeadless(emulator, Number.POSITIVE_INFINITY));
  } finally { emulator.dispose(); }
});

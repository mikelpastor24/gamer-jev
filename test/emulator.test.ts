import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { createDefaultRegistry, EmulatorRegistry } from "../src/emulator/registry.js";

test("a real Game Boy core renders the original demo ROM", () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  try {
    emulator.advance({ buttons: [], frames: 5 });
    const screen = emulator.captureFrame();
    assert.equal(screen.number, 5);
    assert.equal(screen.pixels.length, 160 * 144 * 4);
    assert.equal(screen.pixels[3], 255);
    assert.notEqual(screen.pixels[0], screen.pixels[4]);
    assert.equal(emulator.rom.title, "GAMER JEV DEMO");
  } finally { emulator.dispose(); }
});

test("held directions reach the ROM and are released after the action", () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  try {
    emulator.advance({ buttons: [], frames: 5 });
    const before = emulator.readMemory(0xff43, 1)[0]!;
    emulator.advance({ buttons: ["RIGHT"], frames: 10 });
    const after = emulator.readMemory(0xff43, 1)[0]!;
    assert.equal((after - before + 256) % 256, 10);
    assert.equal(emulator.readMemory(0xff00, 1)[0]! & 0x0f, 0x0f);
    emulator.advance({ buttons: [], frames: 10 });
    assert.equal(emulator.readMemory(0xff43, 1)[0], after);
  } finally { emulator.dispose(); }
});

test("invalid actions are rejected before changing the machine", () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  try {
    for (const action of [
      { buttons: ["INVALID"], frames: 1 },
      { buttons: ["LEFT", "RIGHT"], frames: 1 },
      { buttons: ["A", "A"], frames: 1 },
      ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 601].map((frames) => ({ buttons: [], frames })),
    ]) assert.throws(() => emulator.advance(action));
    assert.equal(emulator.frameNumber, 0);
    assert.equal(emulator.readMemory(0xff00, 1)[0]! & 0x0f, 0x0f);
  } finally { emulator.dispose(); }
});

test("frame and memory observations cannot mutate emulator state", () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  try {
    emulator.advance({ buttons: [], frames: 5 });
    const screen = emulator.captureFrame();
    const original = screen.pixels[0];
    screen.pixels[0] = original! ^ 0xff;
    assert.equal(emulator.captureFrame().pixels[0], original);
    emulator.readMemory(0xc000, 1)[0] = 123;
    assert.notEqual(emulator.readMemory(0xc000, 1)[0], 123);
    assert.throws(() => emulator.readMemory(0xffff, 2));
    assert.throws(() => emulator.readMemory(-1, 1));
    const cartridge = emulator.readRom(0x134, 16);
    const titleByte = cartridge[0]; cartridge[0] = titleByte! ^ 0xff;
    assert.equal(emulator.readRom(0x134, 1)[0], titleByte);
    for (const [offset, length] of [[-1, 1], [0, 0], [0, 0x4001], [0x8000, 1], [0.5, 1]]) {
      assert.throws(() => emulator.readRom(offset!, length!));
    }
    assert.equal(emulator.frameNumber, 5);
  } finally { emulator.dispose(); }
});

test("a core failure releases held inputs without advancing the frame counter", () => {
  const rom = createDemoRom();
  rom[0x150] = 0xd3; // Illegal Game Boy opcode
  const emulator = new GameBoyEmulator(rom);
  try {
    assert.throws(() => emulator.advance({ buttons: ["RIGHT"], frames: 1 }));
    assert.equal(emulator.frameNumber, 0);
    assert.equal(emulator.readMemory(0xff00, 1)[0]! & 0x0f, 0x0f);
  } finally { emulator.dispose(); }
});

test("a JSON checkpoint restores the screen and deterministic continuation", () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  try {
    emulator.advance({ buttons: [], frames: 5 });
    emulator.advance({ buttons: ["RIGHT"], frames: 7 });
    const saved = JSON.parse(JSON.stringify(emulator.saveState())) as unknown;
    const savedFrame = emulator.captureFrame();
    emulator.advance({ buttons: ["LEFT"], frames: 13 });
    const expected = emulator.captureFrame();
    const memory = emulator.readMemory(0xff42, 2);
    emulator.restoreState(saved);
    assert.equal(emulator.frameNumber, 12);
    assert.deepEqual(emulator.captureFrame().pixels, savedFrame.pixels);
    emulator.advance({ buttons: ["LEFT"], frames: 13 });
    assert.deepEqual(emulator.captureFrame().pixels, expected.pixels);
    assert.deepEqual(emulator.readMemory(0xff42, 2), memory);
  } finally { emulator.dispose(); }
});

test("corrupt and incompatible checkpoints leave the running emulator intact", () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  try {
    emulator.advance({ buttons: [], frames: 5 });
    const saved = emulator.saveState();
    for (const state of [null, {}, { ...saved, romSha256: "different" },
      { ...saved, backendVersion: "future" }, { ...saved, consoleId: "other-console" },
      { ...saved, frame: -1 }, { ...saved, payload: { core: [], timing: {} } }]) {
      assert.throws(() => emulator.restoreState(state));
      assert.equal(emulator.frameNumber, 5);
    }
    emulator.advance({ buttons: [], frames: 1 });
    assert.equal(emulator.frameNumber, 6);
  } finally { emulator.dispose(); }
});

test("reset restarts the cartridge and dispose makes further calls fail", () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  emulator.advance({ buttons: ["RIGHT"], frames: 10 });
  emulator.reset();
  assert.equal(emulator.frameNumber, 0);
  emulator.dispose();
  emulator.dispose();
  assert.throws(() => emulator.advance({ buttons: [], frames: 1 }));
  assert.throws(() => emulator.captureFrame());
});

test("ROM headers reject truncated images and Color-only cartridges", () => {
  assert.throws(() => new GameBoyEmulator(new Uint8Array(100)), /at least/);
  const rom = createDemoRom();
  rom[0x148] = 1;
  assert.throws(() => new GameBoyEmulator(rom), /size/);
  rom[0x148] = 0;
  rom[0x143] = 0xc0;
  assert.throws(() => new GameBoyEmulator(rom), /Color-only/);
});

test("the console registry supports independent asynchronous factories", async () => {
  const registry = new EmulatorRegistry();
  const original = createDefaultRegistry().list()[0]!;
  const descriptor = { ...original, consoleId: "fixture-console", name: "Fixture console" };
  let usedFactory = false;
  registry.register({ descriptor, create: async (rom) => {
    usedFactory = true;
    return new GameBoyEmulator(rom);
  } });
  assert.equal(registry.list()[0]?.consoleId, "fixture-console");
  const emulator = await registry.create("fixture-console", createDemoRom());
  emulator.dispose();
  assert.equal(usedFactory, true);
  await assert.rejects(registry.create("unknown", createDemoRom()), /Unsupported console/);
  assert.throws(() => registry.register({ descriptor, create: (rom) => new GameBoyEmulator(rom) }), /already registered/);
});

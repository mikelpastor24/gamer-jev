import { createHash } from "node:crypto";
import type { AudioChunk, AudioSource, Emulator, EmulatorAction, EmulatorDescriptor, EmulatorState, Frame, MemoryReader, RomInfo, RomReader } from "../../core/emulator.js";
import { validateAction } from "../../core/emulator.js";
import { GAME_BOY_FPS, ServerboyBridge, validateSnapshot } from "./serverboy.js";

export const GAME_BOY_DESCRIPTOR: EmulatorDescriptor = Object.freeze({
  consoleId: "game-boy",
  name: "Game Boy",
  backendId: "serverboy",
  backendVersion: "0.0.7",
  buttons: Object.freeze(["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "START", "SELECT"]),
  screen: Object.freeze({ width: 160, height: 144 }),
  framesPerSecond: GAME_BOY_FPS,
  capabilities: Object.freeze({ saveState: true, readMemory: true, audio: true }),
});

const ROM_BANKS = new Map([[0, 2], [1, 4], [2, 8], [3, 16], [4, 32], [5, 64], [6, 128], [7, 256], [8, 512], [0x52, 72], [0x53, 80], [0x54, 96]]);

export class GameBoyEmulator implements Emulator, MemoryReader, RomReader, AudioSource {
  readonly descriptor = GAME_BOY_DESCRIPTOR;
  readonly rom: RomInfo;
  private readonly romBytes: Buffer;
  private bridge: ServerboyBridge;
  private frames = 0;
  private disposed = false;

  constructor(bytes: Uint8Array) {
    if (bytes.length < 0x8000) throw new Error("A Game Boy ROM must contain at least two 16 KiB banks.");
    if (bytes[0x143] === 0xc0) throw new Error("Game Boy Color-only ROMs are not supported by the Game Boy adapter.");
    const banks = ROM_BANKS.get(bytes[0x148]!);
    if (!banks || bytes.length !== banks * 0x4000) throw new Error("ROM size does not match its Game Boy cartridge header.");
    this.romBytes = Buffer.from(bytes);
    const titleEnd = bytes[0x143] === 0x80 ? 0x13f : 0x144;
    this.rom = Object.freeze({
      title: this.romBytes.subarray(0x134, titleEnd).toString("ascii").replace(/\0.*$/s, "").trim() || "Untitled ROM",
      sha256: createHash("sha256").update(this.romBytes).digest("hex"),
      byteLength: this.romBytes.length,
    });
    this.bridge = new ServerboyBridge(this.romBytes);
  }

  get frameNumber(): number { return this.frames; }

  advance(action: EmulatorAction): void {
    this.assertActive();
    validateAction(action, this.descriptor.buttons);
    if ((action.buttons.includes("UP") && action.buttons.includes("DOWN")) ||
        (action.buttons.includes("LEFT") && action.buttons.includes("RIGHT"))) {
      throw new Error("Opposite directions cannot be pressed together.");
    }
    for (let frame = 0; frame < action.frames; frame++) {
      this.bridge.step(action.buttons);
      this.frames++;
    }
  }

  captureFrame(): Frame {
    this.assertActive();
    const pixels = this.bridge.screen();
    if (pixels.length !== 160 * 144 * 4) throw new Error("The backend returned an invalid RGBA frame.");
    return { number: this.frames, width: 160, height: 144, format: "rgba8888", pixels };
  }

  drainAudio(): AudioChunk {
    this.assertActive();
    return this.bridge.drainAudio();
  }

  readMemory(address: number, length: number): Uint8Array {
    this.assertActive();
    if (!Number.isSafeInteger(address) || !Number.isSafeInteger(length) || address < 0 || length < 1 || address + length > 0x10000) {
      throw new Error("Memory reads must stay within the 64 KiB Game Boy address space.");
    }
    return this.bridge.readMemory(address, length);
  }

  readRom(offset: number, length: number): Uint8Array {
    this.assertActive();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 ||
        length > 0x4000 || offset + length > this.romBytes.length) {
      throw new Error("Cartridge reads must stay within the loaded ROM and at most 16 KiB.");
    }
    return Uint8Array.from(this.romBytes.subarray(offset, offset + length));
  }

  saveState(): EmulatorState {
    this.assertActive();
    return {
      schemaVersion: 1,
      consoleId: this.descriptor.consoleId,
      backendId: this.descriptor.backendId,
      backendVersion: this.descriptor.backendVersion,
      romSha256: this.rom.sha256,
      frame: this.frames,
      payload: this.bridge.snapshot(),
    };
  }

  restoreState(value: unknown): void {
    this.assertActive();
    if (!value || typeof value !== "object") throw new Error("Invalid emulator state.");
    const state = value as EmulatorState;
    if (state.schemaVersion !== 1 || state.consoleId !== this.descriptor.consoleId ||
        state.backendId !== this.descriptor.backendId || state.backendVersion !== this.descriptor.backendVersion ||
        state.romSha256 !== this.rom.sha256) {
      throw new Error("State is incompatible with the loaded ROM, console, or backend version.");
    }
    if (!Number.isSafeInteger(state.frame) || state.frame < 0) throw new Error("Invalid state frame number.");
    validateSnapshot(state.payload, this.bridge.snapshot());
    // Restore into a new core so an invalid state never replaces a working one.
    const candidate = new ServerboyBridge(this.romBytes);
    try {
      candidate.restore(state.payload);
      if (candidate.screen().length !== 160 * 144 * 4) throw new Error("Invalid restored frame.");
    } catch (error) {
      candidate.dispose();
      throw error;
    }
    this.bridge.dispose();
    this.bridge = candidate;
    this.frames = state.frame;
  }

  reset(): void {
    this.assertActive();
    const replacement = new ServerboyBridge(this.romBytes);
    this.bridge.dispose();
    this.bridge = replacement;
    this.frames = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.bridge.dispose();
    this.disposed = true;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("This emulator has been disposed.");
  }
}

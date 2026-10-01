import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface ServerboyCore {
  memory: Uint8Array;
  frameDone: boolean;
  stopEmulator: number;
  drewFrame: boolean;
  emulatorTicks: number;
  CPUCyclesTotal: number;
  CPUCyclesTotalCurrent: number;
  JoyPad: number;
  OPCODE: Array<(core: ServerboyCore) => void>;
  memoryRead(address: number): number;
  run(): void;
  JoyPadEvent(key: number, pressed: boolean): void;
  saveState(): unknown[];
  saving(state: unknown[]): void;
  swizzleFrameBuffer(): void;
  requestDraw(): void;
}

interface Serverboy {
  loadRom(rom: Buffer): void;
  getScreen(): ArrayLike<number>;
}

interface ServerboyConstructor {
  new (): Serverboy;
  KEYMAP: Record<string, number>;
}

const Serverboy = require("serverboy") as ServerboyConstructor;
const settings = require("serverboy/src/gameboy_core/settings.js") as unknown[];

export const GAME_BOY_FPS = 4_194_304 / 70_224;

// Settings are shared by serverboy instances; every adapter uses this same mode.
settings[0] = false;
settings[1] = false;
settings[2] = true;
settings[4] = false;
settings[6] = 1000 / GAME_BOY_FPS;

export interface ServerboySnapshot {
  readonly core: unknown[];
  readonly timing: {
    readonly emulatorTicks: number;
    readonly cycles: number;
    readonly cycleRemainder: number;
  };
}

/** All access to the pinned backend's undocumented internals lives here. */
export class ServerboyBridge {
  private readonly backend: Serverboy;
  private readonly core: ServerboyCore;

  constructor(private readonly rom: Buffer) {
    this.backend = new Serverboy();
    this.backend.loadRom(rom);
    const internals = Object.values(this.backend).find(
      (value: unknown) => value !== null && typeof value === "object" && "gameboy" in value,
    ) as { gameboy: ServerboyCore } | undefined;
    if (!internals || typeof internals.gameboy.saveState !== "function") {
      throw new Error("The serverboy backend does not expose the expected core API.");
    }
    this.core = internals.gameboy;
    // The legacy backend only logs illegal instructions, some of which have
    // zero cycle cost. Fail instead of allowing an invalid ROM to spin forever.
    this.core.OPCODE = [...this.core.OPCODE];
    for (const opcode of [0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd]) {
      this.core.OPCODE[opcode] = () => { throw new Error(`Illegal Game Boy opcode: 0x${opcode.toString(16).toUpperCase()}. Reset or load a valid checkpoint.`); };
    }
  }

  step(buttons: readonly string[]): void {
    try {
      if ((this.core.stopEmulator & 2) !== 0) throw new Error("The Game Boy core has stopped. Reset or restore a checkpoint.");
      for (const button of buttons) this.core.JoyPadEvent(Serverboy.KEYMAP[button]!, true);
      this.core.frameDone = false;
      // doFrame() loops without a bound if the core faults. One configured CPU
      // interval is one hardware frame; fail promptly if it cannot complete.
      this.core.run();
      if (!this.core.frameDone) throw new Error("The Game Boy core could not complete a frame.");
    } catch (error) {
      this.core.stopEmulator |= 2;
      throw error;
    } finally {
      this.releaseButtons();
    }
  }

  releaseButtons(): void {
    for (const key of Object.values(Serverboy.KEYMAP)) this.core.JoyPadEvent(key, false);
  }

  screen(): Uint8Array {
    return Uint8Array.from(this.backend.getScreen());
  }

  readMemory(address: number, length: number): Uint8Array {
    return Uint8Array.from({ length }, (_, offset) => this.core.memoryRead(address + offset));
  }

  snapshot(): ServerboySnapshot {
    // The native snapshot starts with the entire ROM. Reuse the user's loaded
    // ROM on restore instead of copying it into every checkpoint.
    const core = this.core.saveState().slice(1);
    return JSON.parse(JSON.stringify({
      core,
      timing: {
        emulatorTicks: this.core.emulatorTicks,
        cycles: this.core.CPUCyclesTotal,
        cycleRemainder: this.core.CPUCyclesTotalCurrent,
      },
    })) as ServerboySnapshot;
  }

  restore(snapshot: ServerboySnapshot): void {
    this.core.saving([Array.from(this.rom), ...snapshot.core]);
    this.core.emulatorTicks = snapshot.timing.emulatorTicks;
    this.core.CPUCyclesTotal = snapshot.timing.cycles;
    this.core.CPUCyclesTotalCurrent = snapshot.timing.cycleRemainder;
    this.core.stopEmulator = 1;
    this.releaseButtons();
    this.core.swizzleFrameBuffer();
    this.core.drewFrame = true;
    this.core.requestDraw();
  }

  dispose(): void {
    this.releaseButtons();
    this.core.stopEmulator |= 2;
  }
}

export function validateSnapshot(value: unknown, template: ServerboySnapshot): asserts value is ServerboySnapshot {
  if (!value || typeof value !== "object" || !("core" in value) || !("timing" in value)) {
    throw new Error("Invalid Game Boy state payload.");
  }
  const snapshot = value as ServerboySnapshot;
  const matchesShape = (actual: unknown, expected: unknown): boolean => {
    if (Array.isArray(expected)) {
      return Array.isArray(actual) && actual.length === expected.length &&
        actual.every((item, index) => matchesShape(item, expected[index]));
    }
    if (expected === null) return actual === null;
    return typeof actual === typeof expected && (typeof actual !== "number" || Number.isFinite(actual));
  };
  if (!matchesShape(snapshot.core, template.core) || !snapshot.timing ||
      !Object.values(snapshot.timing).every((number) => typeof number === "number" && Number.isFinite(number)) ||
      Object.keys(template.timing).some((key) => !(key in snapshot.timing))) {
    throw new Error("Invalid Game Boy state data or timing.");
  }
}

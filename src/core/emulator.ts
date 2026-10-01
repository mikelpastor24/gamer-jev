export interface EmulatorDescriptor {
  readonly consoleId: string;
  readonly name: string;
  readonly backendId: string;
  readonly backendVersion: string;
  readonly buttons: readonly string[];
  readonly screen: { readonly width: number; readonly height: number };
  readonly framesPerSecond: number;
  readonly capabilities: { readonly saveState: boolean; readonly readMemory: boolean; readonly audio: boolean };
}

export interface RomInfo {
  readonly title: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface Frame {
  readonly number: number;
  readonly width: number;
  readonly height: number;
  readonly format: "rgba8888";
  readonly pixels: Uint8Array;
}

export interface EmulatorAction {
  readonly buttons: readonly string[];
  readonly frames: number;
}

export interface EmulatorState {
  readonly schemaVersion: 1;
  readonly consoleId: string;
  readonly backendId: string;
  readonly backendVersion: string;
  readonly romSha256: string;
  readonly frame: number;
  readonly payload: unknown;
}

/** A synchronous frame API; factories can initialize asynchronous backends. */
export interface Emulator {
  readonly descriptor: EmulatorDescriptor;
  readonly rom: RomInfo;
  readonly frameNumber: number;
  advance(action: EmulatorAction): void;
  captureFrame(): Frame;
  saveState(): EmulatorState;
  restoreState(state: unknown): void;
  reset(): void;
  dispose(): void;
}

/** Optional capability: profiles receive copies, never mutable emulator memory. */
export interface MemoryReader {
  readMemory(address: number, length: number): Uint8Array;
}

export interface AudioChunk {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  /** Owned, interleaved PCM samples in the range [-1, 1]. */
  readonly samples: Float32Array;
}

/** Optional capability; draining removes samples already delivered to a viewer. */
export interface AudioSource {
  drainAudio(): AudioChunk;
}

export function hasAudio(emulator: Emulator): emulator is Emulator & AudioSource {
  return emulator.descriptor.capabilities.audio && "drainAudio" in emulator && typeof emulator.drainAudio === "function";
}

export const MAX_ACTION_FRAMES = 600;

export function validateAction(action: EmulatorAction, buttons: readonly string[]): void {
  if (!action || !Number.isSafeInteger(action.frames) || action.frames < 1 || action.frames > MAX_ACTION_FRAMES) {
    throw new Error(`Action frames must be an integer between 1 and ${MAX_ACTION_FRAMES}.`);
  }
  if (!Array.isArray(action.buttons) || action.buttons.some((button) => !buttons.includes(button))) {
    throw new Error(`Supported buttons: ${buttons.join(", ")}.`);
  }
  if (new Set(action.buttons).size !== action.buttons.length) {
    throw new Error("An action cannot contain duplicate buttons.");
  }
}

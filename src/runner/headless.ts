import { setImmediate } from "node:timers/promises";
import type { Emulator } from "../core/emulator.js";
import { validateAction } from "../core/emulator.js";

export async function runHeadless(
  emulator: Emulator,
  frames: number,
  buttons: readonly string[] = [],
  signal?: AbortSignal,
): Promise<number> {
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > 1_000_000) {
    throw new Error("Headless frame count must be an integer between 1 and 1000000.");
  }
  validateAction({ buttons, frames: 1 }, emulator.descriptor.buttons);
  let completed = 0;
  while (completed < frames && !signal?.aborted) {
    const batch = Math.min(10, frames - completed);
    emulator.advance({ buttons, frames: batch });
    completed += batch;
    // Allow Ctrl+C, file I/O, and future decision providers between batches.
    await setImmediate();
  }
  return completed;
}

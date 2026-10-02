import { MAX_ACTION_FRAMES } from "../core/emulator.js";

/** Pace controller execution without accumulating an unbounded catch-up workload. */
export class FrameClock {
  constructor(private readonly framesPerSecond: number, private lastTick = performance.now()) {
    if (!Number.isFinite(framesPerSecond) || framesPerSecond <= 0) throw new Error("Invalid emulator frame rate.");
  }

  reset(now = performance.now()): void { this.lastTick = now; }

  dueFrames(now: number, speed: number): number {
    const interval = 1000 / (this.framesPerSecond * speed);
    // Allow a typical 16 ms timer interval at high speed, keeping every batch bounded.
    const maximum = Math.min(MAX_ACTION_FRAMES, Math.max(3, Math.ceil(this.framesPerSecond * speed * 0.016)));
    const frames = Math.min(maximum, Math.floor((now - this.lastTick) / interval));
    if (frames < 1) return 0;
    this.lastTick = Math.max(this.lastTick + frames * interval, now - maximum * interval);
    return frames;
  }
}

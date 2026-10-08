import type { Emulator } from "../core/emulator.js";
import type { AutosaveSettings } from "../config/autosave.js";
import { DEFAULT_AUTOSAVE_SETTINGS, parseAutosaveSettings } from "../config/autosave.js";
import { saveStateFile } from "../emulator/files.js";

interface AutosaveContext {
  readonly emulator: Emulator;
  readonly checkpointPath: string;
  readonly decisions: number | null;
  readonly paused: boolean;
  readonly blocked: boolean;
  readonly record?: ((event: unknown) => void) | undefined;
}

/** One in-flight write, without pausing emulation or owning any controller input. */
export class CheckpointAutosave {
  private settings: AutosaveSettings;
  private revision = 0;
  private decisions = 0;
  private mode: "manual" | "agent" = "manual";
  private manualMs = 0;
  private lastTick = performance.now();
  private manualRunning = false;
  private pending: Promise<void> | undefined;
  private lastSavedAt: string | null = null;
  private lastSavedFrame: number | null = null;
  private error: string | null = null;

  constructor(settings: AutosaveSettings = DEFAULT_AUTOSAVE_SETTINGS,
    private readonly save: typeof saveStateFile = saveStateFile) {
    this.settings = parseAutosaveSettings(settings);
  }

  get status() {
    return { settings: { ...this.settings }, revision: this.revision, saving: this.pending !== undefined,
      lastSavedAt: this.lastSavedAt, lastSavedFrame: this.lastSavedFrame, error: this.error };
  }

  configure(value: unknown, revision: unknown, decisions: number | null, now = performance.now()): void {
    const next = parseAutosaveSettings(value);
    if (revision !== this.revision) throw new Error("Autosave settings changed in another window. Reload settings and try again.");
    this.settings = next; this.revision++;
    this.reset(decisions, now);
    this.error = null;
  }

  /** Start a new interval after a save, timeline change, or play-mode change. */
  reset(decisions: number | null, now = performance.now(), newCartridge = false): void {
    this.mode = decisions === null ? "manual" : "agent";
    this.decisions = decisions ?? 0; this.manualMs = 0; this.lastTick = now; this.manualRunning = false;
    if (newCartridge) { this.lastSavedAt = null; this.lastSavedFrame = null; this.error = null; }
  }

  tick(context: AutosaveContext, now = performance.now()): void {
    const mode = context.decisions === null ? "manual" : "agent";
    if (mode !== this.mode) this.reset(context.decisions, now);
    if (this.manualRunning) this.manualMs += Math.max(0, now - this.lastTick);
    this.lastTick = now;
    this.manualRunning = this.settings.enabled && mode === "manual" && !context.paused;
    if (!this.settings.enabled || context.blocked || this.pending) return;
    const due = mode === "agent" ? context.decisions! - this.decisions >= this.settings.decisionInterval :
      !context.paused && this.manualMs >= this.settings.manualSeconds * 1000;
    if (!due) return;
    const frame = context.emulator.frameNumber;
    const trigger = mode === "agent" ? "decisions" : "manual-time";
    // Consume the interval at capture time so failures retry at the next interval, never every tick.
    this.decisions = context.decisions ?? 0; this.manualMs = 0;
    this.pending = (async () => {
      let event: unknown;
      try {
        await this.save(context.emulator, context.checkpointPath);
        this.lastSavedAt = new Date().toISOString(); this.lastSavedFrame = frame; this.error = null;
        event = { type: "checkpoint-autosave", trigger, frame, decisions: context.decisions };
      } catch (error: unknown) {
        this.error = error instanceof Error ? error.message.slice(0, 500) : "Checkpoint autosave failed.";
        event = { type: "checkpoint-autosave-failed", trigger, frame, reason: this.error };
      }
      // Diagnostic failures must not reject the background save task or stop gameplay.
      try { context.record?.(event); } catch {}
    })().finally(() => { this.pending = undefined; });
  }

  /** Cartridge changes, explicit checkpoint operations, and shutdown wait for the current write. */
  async flush(): Promise<void> { await this.pending; }
}

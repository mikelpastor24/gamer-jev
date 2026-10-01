import { createHash } from "node:crypto";
import type { ActionRecord, AgentAction, Decision, DecisionProvider, Objectives, ObservationProvider } from "../core/agent.js";
import type { Emulator, Frame } from "../core/emulator.js";
import { validateAction } from "../core/emulator.js";
import { AgentFailure, RequestBudget } from "../jev/requests.js";

export interface AgentSessionOptions {
  readonly mode: "gateway" | "mock";
  readonly objectives: Objectives;
  readonly observer: ObservationProvider;
  readonly decider: DecisionProvider;
  readonly budget: RequestBudget;
  readonly actionFrames: number;
  readonly maxDecisions: number;
  readonly maxSeconds: number;
  readonly record?: (event: unknown) => void;
}

export function controllerActions(buttons: readonly string[], frames: number): readonly AgentAction[] {
  const actions: AgentAction[] = buttons.map((button, index) => ({
    id: /^[A-Z][A-Z0-9_]*$/.test(button) ? `press_${button.toLowerCase()}` : `press_${button.toLowerCase().replace(/[^a-z0-9_]/g, "_")}_${index}`,
    description: `Hold ${button} for ${frames} frames, then release for 4 frames.`, buttons: [button], frames, stop: false,
  }));
  for (const direction of ["UP", "DOWN", "LEFT", "RIGHT"]) for (const button of ["A", "B"]) {
    if (buttons.includes(direction) && buttons.includes(button)) actions.push({
      id: `press_${direction.toLowerCase()}_${button.toLowerCase()}`,
      description: `Hold ${direction} and ${button} together for ${frames} frames, then release for 4 frames.`,
      buttons: [direction, button], frames, stop: false,
    });
  }
  actions.push({ id: "wait", description: `Wait ${frames} frames without pressing buttons.`, buttons: [], frames, stop: false },
    { id: "stop", description: "Stop this session. Completion remains unverified without a progress checker.", buttons: [], frames: 0, stop: true });
  if (actions.length > 255 || new Set(actions.map((action) => action.id)).size !== actions.length) throw new Error("The controller action set must have at most 255 unique identifiers.");
  for (const action of actions) if (!action.stop) validateAction(action, buttons);
  return actions;
}

export class AgentSession {
  private state: "idle" | "paused" | "observing" | "thinking" | "acting" | "stopped" | "error" = "idle";
  private generation = 0;
  private controller: AbortController | undefined;
  private pending: Promise<void> | undefined;
  private active: { action: AgentAction; fromFrame: number; remaining: number; release: number } | undefined;
  private history: ActionRecord[] = [];
  private previous: Frame | undefined;
  private screenHash: string | undefined;
  private unchangedScreens = 0;
  private observation = "";
  private decision: Decision | undefined;
  private decisions = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private reason: string | null = null;
  private readonly actions: readonly AgentAction[];
  private readonly deadline: number;
  private readonly deadlineTimer: ReturnType<typeof setTimeout>;

  constructor(private readonly emulator: Emulator, private readonly options: AgentSessionOptions) {
    if (!Number.isSafeInteger(options.maxDecisions) || options.maxDecisions < 1 ||
        !Number.isSafeInteger(options.maxSeconds) || options.maxSeconds < 1 || options.maxSeconds > 86400) throw new Error("Invalid agent session limits.");
    this.actions = controllerActions(emulator.descriptor.buttons, options.actionFrames);
    this.deadline = Date.now() + options.maxSeconds * 1000;
    this.deadlineTimer = setTimeout(() => this.stop("Session time limit reached."), options.maxSeconds * 1000);
    this.deadlineTimer.unref();
    this.record({ type: "session", mode: options.mode, objectives: options.objectives, romSha256: emulator.rom.sha256,
      console: emulator.descriptor.consoleId, actions: this.actions, limits: {
        decisions: options.maxDecisions, seconds: options.maxSeconds, requests: options.budget.limits,
      } });
  }

  get terminal(): boolean { return this.state === "stopped" || this.state === "error"; }
  get advancing(): boolean { return this.state === "acting" || this.state === "idle"; }
  get snapshot() {
    return { mode: this.options.mode, state: this.state, goal: this.options.objectives.goal,
      decisions: this.decisions, maxDecisions: this.options.maxDecisions,
      requests: this.options.budget.requests, maxRequests: this.options.budget.limits.maxRequests,
      inputTokens: this.inputTokens, outputTokens: this.outputTokens,
      observation: this.observation, action: this.decision?.actionId ?? null,
      confidence: this.decision?.confidence ?? null, unchangedScreens: this.unchangedScreens,
      stopReason: this.reason, completion: "unverified" };
  }

  pause(): void {
    if (this.terminal) return;
    this.cancelActive();
    this.state = "paused";
  }

  resume(): void {
    if (this.terminal) throw new Error("This agent session has ended. Start a new process for a new session and budget.");
    if (this.state === "paused") this.state = "idle";
  }

  /** A restored or reset emulator must not inherit visual history from another timeline. */
  clearHistory(): void {
    this.pause();
    this.history = []; this.previous = undefined; this.screenHash = undefined;
    this.unchangedScreens = 0; this.observation = ""; this.decision = undefined;
    this.record({ type: "timeline-reset", frame: this.emulator.frameNumber });
  }

  stop(reason: string, failed = false): void {
    if (this.terminal) return;
    this.cancelActive();
    this.state = failed ? "error" : "stopped"; this.reason = reason;
    clearTimeout(this.deadlineTimer);
    this.record({ type: "stop", ...this.snapshot, frame: this.emulator.frameNumber });
  }

  tick(frames: number): void {
    if (this.terminal || this.state === "paused") return;
    if (!Number.isSafeInteger(frames) || frames < 1 || frames > 600) throw new Error("Invalid agent tick frame count.");
    if (Date.now() >= this.deadline) { this.stop("Session time limit reached."); return; }
    if (this.active) {
      const active = this.active;
      const held = Math.min(frames, active.remaining);
      if (held) { this.emulator.advance({ buttons: active.action.buttons, frames: held }); active.remaining -= held; frames -= held; }
      const released = Math.min(frames, active.release);
      if (released) { this.emulator.advance({ buttons: [], frames: released }); active.release -= released; }
      if (!active.remaining && !active.release) {
        this.finishAction(false); this.active = undefined; this.state = "idle";
        if (this.decisions >= this.options.maxDecisions) this.stop("Decision limit reached.");
      }
      return;
    }
    if (this.pending) return;
    if (this.decisions >= this.options.maxDecisions) { this.stop("Decision limit reached."); return; }
    const generation = this.generation;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.state = "observing";
    const task = this.choose(signal, generation).catch((error: unknown) => {
      if (generation !== this.generation || signal.aborted) return;
      this.stop(error instanceof AgentFailure ? error.message : "Agent failed. Check configuration and provider output.", true);
    }).finally(() => { if (this.pending === task) this.pending = undefined; });
    this.pending = task;
  }

  async waitForPending(): Promise<void> { await this.pending; }

  private async choose(signal: AbortSignal, generation: number): Promise<void> {
    const frame = this.emulator.captureFrame();
    const hash = createHash("sha256").update(frame.pixels).digest("hex");
    const observation = await this.options.observer.observe(frame, this.previous, this.options.objectives, signal);
    if (signal.aborted || generation !== this.generation) return;
    if (typeof observation.text !== "string" || !observation.text.trim() || observation.text.length > 6000) throw new AgentFailure("Invalid visual observation.");
    this.observation = observation.text;
    this.inputTokens += observation.usage.inputTokens; this.outputTokens += observation.usage.outputTokens;
    this.unchangedScreens = hash === this.screenHash ? this.unchangedScreens + 1 : 0;
    this.screenHash = hash; this.previous = frame;
    this.state = "thinking";
    const context = { objectives: this.options.objectives, console: this.emulator.descriptor.consoleId,
      frame: frame.number, observation: this.observation, unchangedScreens: this.unchangedScreens,
      history: [...this.history], actions: this.actions };
    const decision = await this.options.decider.decide(context, signal);
    if (signal.aborted || generation !== this.generation) return;
    const action = this.actions.find((candidate) => candidate.id === decision.actionId);
    if (!action) throw new AgentFailure("Jev selected an action outside the supplied controller action set.");
    if (decision.confidence !== null && (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1)) throw new AgentFailure("Invalid Jev confidence.");
    this.decisions++; this.decision = decision;
    this.inputTokens += decision.usage.inputTokens; this.outputTokens += decision.usage.outputTokens;
    this.record({ type: "decision", context, observation, decision, screenHash: hash });
    if (action.stop) { this.stop("Jev requested stop. Objective completion is unverified."); return; }
    this.active = { action, fromFrame: frame.number, remaining: action.frames, release: action.buttons.length ? 4 : 0 };
    this.state = "acting";
  }

  private finishAction(interrupted: boolean): void {
    if (!this.active) return;
    const record: ActionRecord = { actionId: this.active.action.id, fromFrame: this.active.fromFrame,
      toFrame: this.emulator.frameNumber, observation: this.observation.slice(0, 1500), interrupted };
    this.history.push(record);
    this.history = this.history.slice(-12);
    this.record({ type: "action", ...record });
  }

  private cancelActive(): void {
    this.generation++; this.controller?.abort();
    this.finishAction(true); this.active = undefined;
  }

  private record(event: unknown): void { this.options.record?.(event); }
}

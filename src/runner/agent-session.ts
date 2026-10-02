import { createHash } from "node:crypto";
import type { ActionRecord, AgentAction, Decision, DecisionExchange, DecisionProvider, DecisionProviderId, GameState, Objectives, ObservationProvider, VisionProviderId } from "../core/agent.js";
import type { Emulator, Frame } from "../core/emulator.js";
import { controllerActions, validateAgentActions } from "../core/actions.js";
import { validateGameState } from "../core/game-state.js";
import { AgentFailure, RequestBudget } from "../providers/requests.js";
import type { DiagnosticEvent, DiagnosticSink } from "../core/diagnostics.js";
import { redactLogEvent } from "../core/redaction.js";
export { controllerActions } from "../core/actions.js";

export interface AgentSessionOptions {
  readonly mode: DecisionProviderId;
  readonly visionProvider?: VisionProviderId;
  readonly objectives: Objectives;
  readonly observer: ObservationProvider;
  readonly decider: DecisionProvider;
  readonly budget: RequestBudget;
  readonly actionFrames: number;
  readonly maxDecisions: number;
  readonly maxSeconds: number;
  readonly record?: (event: unknown) => void;
  readonly diagnostics?: DiagnosticSink;
  readonly redactInspection?: (value: unknown) => unknown;
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
  private gameState: GameState | undefined;
  private decision: Decision | undefined;
  private decisions = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private reason: string | null = null;
  private exchange: DecisionExchange | null = null;
  private completedExchange: DecisionExchange | null = null;
  private exchangeRevision = 0;
  private exchangeSequence = 0;
  private readonly actions: readonly AgentAction[];
  private readonly visionProvider: VisionProviderId;
  private readonly deadline: number;
  private readonly deadlineTimer: ReturnType<typeof setTimeout>;

  constructor(private readonly emulator: Emulator, private readonly options: AgentSessionOptions) {
    if (!Number.isSafeInteger(options.maxDecisions) || options.maxDecisions < 1 ||
        !Number.isSafeInteger(options.maxSeconds) || options.maxSeconds < 1 || options.maxSeconds > 86400) throw new Error("Invalid agent session limits.");
    this.actions = controllerActions(emulator.descriptor.buttons, options.actionFrames);
    this.visionProvider = options.visionProvider ?? (options.observer.kind === "state" ? "none" : options.mode === "mock" ? "mock" : "gateway");
    this.deadline = Date.now() + options.maxSeconds * 1000;
    this.deadlineTimer = setTimeout(() => this.stop("Session time limit reached."), options.maxSeconds * 1000);
    this.deadlineTimer.unref();
    this.record({ type: "session", mode: options.mode, visionProvider: this.visionProvider,
      observationMode: options.observer.kind ?? "custom", objectives: options.objectives, romSha256: emulator.rom.sha256,
      console: emulator.descriptor.consoleId, controllerActions: this.actions, limits: {
        decisions: options.maxDecisions, seconds: options.maxSeconds, requests: options.budget.limits,
      } });
    this.diagnose("info", "session-started", { mode: options.mode, visionProvider: this.visionProvider,
      observationMode: options.observer.kind ?? "custom", maxDecisions: options.maxDecisions, maxSeconds: options.maxSeconds });
  }

  get terminal(): boolean { return this.state === "stopped" || this.state === "error"; }
  get advancing(): boolean { return this.state === "acting" || this.state === "idle"; }
  get snapshot() {
    return { mode: this.options.mode, visionProvider: this.visionProvider, state: this.state, goal: this.options.objectives.goal,
      observationMode: this.options.observer.kind ?? "custom", gameState: this.gameState ?? null,
      decisions: this.decisions, maxDecisions: this.options.maxDecisions,
      requests: this.options.budget.requests, maxRequests: this.options.budget.limits.maxRequests,
      inputTokens: this.inputTokens, outputTokens: this.outputTokens,
      observation: this.observation, action: this.decision?.actionId ?? null,
      confidence: this.decision?.confidence ?? null, unchangedScreens: this.unchangedScreens,
      exchange: { revision: this.exchangeRevision, id: this.exchange?.id ?? null, frame: this.exchange?.frame ?? null, status: this.exchange?.status ?? null },
      stopReason: this.reason, completion: "unverified" };
  }

  get inspection() { return { revision: this.exchangeRevision, exchange: structuredClone(this.exchange),
    completed: this.completedExchange?.id !== this.exchange?.id ? structuredClone(this.completedExchange) : null }; }

  pause(): void {
    if (this.terminal) return;
    const previousState = this.state;
    this.cancelActive();
    this.state = "paused";
    if (previousState !== "paused") this.diagnose("info", "paused", { previousState, generation: this.generation });
  }

  resume(): void {
    if (this.terminal) throw new Error("This agent session has ended. Start a new process for a new session and budget.");
    if (this.state === "paused") { this.state = "idle"; this.diagnose("info", "resumed", { generation: this.generation }); }
  }

  /** A restored or reset emulator must not inherit visual history from another timeline. */
  clearHistory(): void {
    this.pause();
    this.options.observer.reset?.();
    this.history = []; this.previous = undefined; this.screenHash = undefined;
    this.unchangedScreens = 0; this.observation = ""; this.decision = undefined; this.gameState = undefined;
    this.exchange = null; this.completedExchange = null; this.exchangeRevision++;
    this.record({ type: "timeline-reset", frame: this.emulator.frameNumber });
    this.diagnose("info", "timeline-reset", { generation: this.generation });
  }

  stop(reason: string, failed = false): void {
    if (this.terminal) return;
    const stage = this.state;
    if (failed && this.exchange?.status === "pending") this.updateExchange({ status: "error", error: reason });
    this.cancelActive();
    this.state = failed ? "error" : "stopped"; this.reason = reason;
    clearTimeout(this.deadlineTimer);
    this.record({ type: "stop", ...this.snapshot, frame: this.emulator.frameNumber });
    this.diagnose(failed ? "error" : "info", "session-stopped", { stage, reason, decisions: this.decisions,
      requests: this.options.budget.requests, generation: this.generation });
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
    this.diagnose("debug", "observation-started", { generation });
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
    if (signal.aborted || generation !== this.generation) { this.diagnose("debug", "observation-discarded", { generation }); return; }
    if (typeof observation.text !== "string" || !observation.text.trim() || observation.text.length > 6000) throw new AgentFailure("Invalid visual observation.");
    this.observation = observation.text;
    const actions = structuredClone(observation.actions ?? this.actions);
    validateAgentActions(actions, this.emulator.descriptor.buttons);
    if (observation.gameState) validateGameState(observation.gameState, frame.number);
    this.gameState = observation.gameState ? structuredClone(observation.gameState) : undefined;
    this.inputTokens += observation.usage.inputTokens; this.outputTokens += observation.usage.outputTokens;
    this.unchangedScreens = hash === this.screenHash ? this.unchangedScreens + 1 : 0;
    this.screenHash = hash; this.previous = frame;
    this.state = "thinking";
    const context = { objectives: this.options.objectives, console: this.emulator.descriptor.consoleId,
      frame: frame.number, observation: this.observation, unchangedScreens: this.unchangedScreens,
      history: [...this.history], actions, ...(this.gameState ? { gameState: structuredClone(this.gameState) } : {}) };
    this.diagnose("debug", "decision-requested", { generation, sequence: this.decisions + 1, context,
      observationModel: observation.model, observationUsage: observation.usage, requests: this.options.budget.requests });
    const started = performance.now();
    const exchangeId = ++this.exchangeSequence;
    this.exchange = { id: exchangeId, frame: frame.number, provider: this.options.mode, status: "pending",
      request: this.inspectData({ state: context }), response: null, decision: null, warnings: [], error: null, durationMs: null };
    this.exchangeRevision++;
    const decision = await this.options.decider.decide(context, signal, (event) => {
      if (signal.aborted || generation !== this.generation || this.exchange?.id !== exchangeId) return;
      if (event.type === "warning") {
        const safe = this.inspectData({ message: event.message.slice(0, 500) });
        this.updateExchange({ warnings: [...this.exchange.warnings, String(safe.message)].slice(-8) });
      } else this.updateExchange({ [event.type]: this.inspectData(event.data) });
    });
    if (signal.aborted || generation !== this.generation) { this.diagnose("debug", "decision-discarded", { generation }); return; }
    const action = actions.find((candidate) => candidate.id === decision.actionId);
    if (!action) throw new AgentFailure("Jev selected an action outside the supplied controller action set.");
    if (decision.confidence !== null && (!Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1)) throw new AgentFailure("Invalid Jev confidence.");
    this.decisions++; this.decision = decision;
    this.updateExchange({ status: "complete", decision: this.inspectData({ ...decision }),
      response: this.exchange!.response ?? this.inspectData({ ...decision }), durationMs: Number((performance.now() - started).toFixed(3)) });
    this.completedExchange = this.exchange;
    this.inputTokens += decision.usage.inputTokens; this.outputTokens += decision.usage.outputTokens;
    this.record({ type: "decision", context, observation, decision, screenHash: hash });
    this.diagnose("info", "decision-selected", { generation, sequence: this.decisions, decision,
      durationMs: Number((performance.now() - started).toFixed(3)) });
    if (action.stop) { this.stop("Jev requested stop. Objective completion is unverified."); return; }
    this.active = { action, fromFrame: frame.number, remaining: action.frames, release: action.buttons.length ? 4 : 0 };
    this.state = "acting";
    this.diagnose("info", "action-started", { actionId: action.id, buttons: action.buttons,
      frames: action.frames, releaseFrames: this.active.release });
  }

  private finishAction(interrupted: boolean): void {
    if (!this.active) return;
    const record: ActionRecord = { actionId: this.active.action.id, fromFrame: this.active.fromFrame,
      toFrame: this.emulator.frameNumber, observation: this.observation.slice(0, 1500), interrupted };
    this.history.push(record);
    this.history = this.history.slice(-12);
    this.record({ type: "action", ...record });
    this.diagnose("info", "action-completed", { ...record, advancedFrames: record.toFrame - record.fromFrame });
  }

  private cancelActive(): void {
    if (this.exchange?.status === "pending") this.updateExchange({ status: "cancelled", error: "Decision request cancelled. Its response will not be executed." });
    this.generation++; this.controller?.abort();
    this.finishAction(true); this.active = undefined;
  }

  private record(event: unknown): void { this.options.record?.(event); }
  private diagnose(level: DiagnosticEvent["level"], event: string, data: Readonly<Record<string, unknown>>): void {
    this.options.diagnostics?.({ component: "agent", level, event, frame: this.emulator.frameNumber, data });
  }
  private updateExchange(change: Partial<DecisionExchange>): void {
    if (this.exchange) { this.exchange = { ...this.exchange, ...change }; this.exchangeRevision++; }
  }
  private inspectData(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    try {
      const json = JSON.stringify(this.options.redactInspection?.(value) ?? redactLogEvent(value));
      if (Buffer.byteLength(json) <= 1024 * 1024) return JSON.parse(json) as Record<string, unknown>;
      return { unavailable: "Inspection data exceeds the 1 MiB limit." };
    } catch { return { unavailable: "Inspection data could not be serialized." }; }
  }
}

import { createHash } from "node:crypto";
import type { ActionRecord, AgentAction, AgentSettings, Decision, DecisionExchange, DecisionProvider, DecisionProviderId, GameState, Objectives, ObservationProvider, VisionProviderId } from "../core/agent.js";
import type { Emulator, Frame } from "../core/emulator.js";
import { controllerActions, validateAgentActions } from "../core/actions.js";
import { validateGameState } from "../core/game-state.js";
import { AgentFailure, RequestBudget } from "../providers/requests.js";
import type { DiagnosticEvent, DiagnosticSink } from "../core/diagnostics.js";
import { redactLogEvent } from "../core/redaction.js";
import { parseAgentSettings } from "../config/agent-settings.js";
import { actionResult, AgentFeedbackTracker } from "./feedback.js";
export { controllerActions } from "../core/actions.js";

export interface AgentSessionOptions {
  readonly mode: DecisionProviderId;
  readonly visionProvider?: VisionProviderId;
  readonly objectives: Objectives;
  readonly observer: ObservationProvider;
  readonly decider: DecisionProvider;
  readonly budget: RequestBudget;
  readonly actionFrames: number;
  readonly maxDecisions: number | null;
  readonly maxSeconds: number | null;
  readonly record?: (event: unknown) => void;
  readonly diagnostics?: DiagnosticSink;
  readonly redactInspection?: (value: unknown) => unknown;
}


export class AgentSession {
  private state: "idle" | "paused" | "observing" | "thinking" | "acting" | "stopped" | "error" = "idle";
  private generation = 0;
  private controller: AbortController | undefined;
  private pending: Promise<void> | undefined;
  private active: { action: AgentAction; fromFrame: number; remaining: number; release: number; screenHash: string; beforeState: GameState | undefined } | undefined;
  private history: ActionRecord[] = [];
  private readonly feedback = new AgentFeedbackTracker();
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
  private actions: readonly AgentAction[];
  private settings: AgentSettings;
  private settingsRevision = 0;
  private visionProvider: VisionProviderId;
  private readonly startedAt = Date.now();
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly emulator: Emulator, private options: AgentSessionOptions) {
    this.settings = parseAgentSettings({ objectives: options.objectives, maxDecisions: options.maxDecisions,
      maxSeconds: options.maxSeconds, maxRequests: options.budget.limits.maxRequests, actionFrames: options.actionFrames });
    this.actions = controllerActions(emulator.descriptor.buttons, options.actionFrames);
    this.visionProvider = options.visionProvider ?? (options.observer.kind === "state" ? "none" : options.mode === "mock" ? "mock" : "gateway");
    this.scheduleDeadline();
    this.record({ type: "session", mode: options.mode, visionProvider: this.visionProvider,
      observationMode: options.observer.kind ?? "custom", objectives: options.objectives, romSha256: emulator.rom.sha256,
      console: emulator.descriptor.consoleId, controllerActions: this.actions, limits: {
        decisions: options.maxDecisions, seconds: options.maxSeconds, requests: options.budget.limits,
      } });
    this.diagnose("info", "session-started", { mode: options.mode, visionProvider: this.visionProvider,
      observationMode: options.observer.kind ?? "custom", maxDecisions: options.maxDecisions, maxSeconds: options.maxSeconds });
  }

  get terminal(): boolean { return this.state === "stopped" || this.state === "error"; }
  get advancing(): boolean { return !this.terminal && this.state !== "paused"; }
  get snapshot() {
    return { mode: this.options.mode, visionProvider: this.visionProvider, state: this.state, goal: this.settings.objectives.goal,
      observationMode: this.options.observer.kind ?? "custom", gameState: this.gameState ?? null,
      decisions: this.decisions, maxDecisions: this.settings.maxDecisions,
      requests: this.options.budget.requests, maxRequests: this.options.budget.limits.maxRequests,
      maxSeconds: this.settings.maxSeconds, elapsedSeconds: Math.floor((Date.now() - this.startedAt) / 1000), settingsRevision: this.settingsRevision,
      inputTokens: this.inputTokens, outputTokens: this.outputTokens,
      observation: this.observation, action: this.decision?.actionId ?? null,
      confidence: this.decision?.confidence ?? null, unchangedScreens: this.unchangedScreens,
      exchange: { revision: this.exchangeRevision, id: this.exchange?.id ?? null, frame: this.exchange?.frame ?? null, status: this.exchange?.status ?? null },
      stopReason: this.reason, completion: "unverified" };
  }

  get inspection() { return { revision: this.exchangeRevision, exchange: structuredClone(this.exchange),
    completed: this.completedExchange?.id !== this.exchange?.id ? structuredClone(this.completedExchange) : null }; }

  get configuration() { return { revision: this.settingsRevision, settings: this.inspectData({ ...this.settings }) }; }

  /** Local session recreation; browser inspection must use the redacted configuration instead. */
  copySettings(): AgentSettings { return structuredClone(this.settings); }

  /** Replace validated providers while retaining the budget, counters, and original timer. */
  setProviders(providers: Pick<AgentSessionOptions, "mode" | "visionProvider" | "observer" | "decider">): void {
    this.clearHistory();
    this.options = { ...this.options, ...providers };
    this.visionProvider = providers.visionProvider ?? "none";
    this.options.observer.setActionFrames?.(this.settings.actionFrames);
    this.record({ type: "session-providers", mode: this.options.mode, visionProvider: this.visionProvider,
      frame: this.emulator.frameNumber, decisions: this.decisions, requests: this.options.budget.requests });
  }

  /** Editing settings explicitly reopens an ended session, paused, without resetting any counters. */
  updateSettings(value: unknown, revision: unknown): void {
    const next = parseAgentSettings(value);
    if (revision !== this.settingsRevision) throw new Error("Agent settings changed in another window. Reload the settings and try again.");
    const actions = controllerActions(this.emulator.descriptor.buttons, next.actionFrames);
    this.options.observer.setActionFrames?.(next.actionFrames);
    this.cancelActive();
    this.settings = next; this.actions = actions; this.settingsRevision++;
    this.options.budget.setMaxRequests(next.maxRequests);
    this.state = "paused"; this.reason = null;
    this.observation = ""; this.gameState = undefined; this.decision = undefined;
    this.record({ type: "session-settings", revision: this.settingsRevision, settings: next, frame: this.emulator.frameNumber,
      decisions: this.decisions, requests: this.options.budget.requests });
    this.diagnose("info", "settings-updated", { revision: this.settingsRevision, settings: next, generation: this.generation });
    const exhausted = this.exhaustedLimit();
    if (exhausted) this.stop(exhausted);
    else this.scheduleDeadline();
  }

  pause(): void {
    if (this.terminal) return;
    const previousState = this.state;
    this.cancelActive();
    this.state = "paused";
    if (previousState !== "paused") this.diagnose("info", "paused", { previousState, generation: this.generation });
  }

  resume(): void {
    if (this.terminal) throw new Error("This agent session has ended. Apply agent settings to continue with the current counters, or start a new process.");
    const exhausted = this.exhaustedLimit();
    if (exhausted) { this.stop(exhausted); throw new Error(exhausted); }
    if (this.state === "paused") { this.state = "idle"; this.diagnose("info", "resumed", { generation: this.generation }); }
  }

  /** A restored or reset emulator must not inherit visual history from another timeline. */
  clearHistory(): void {
    this.pause();
    this.options.observer.reset?.();
    this.history = []; this.previous = undefined; this.screenHash = undefined;
    this.feedback.reset();
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

  /** Continuous viewer ticks consume neutral frames during model work; headless ticks stay deterministic. */
  tick(frames: number, continuous = false): void {
    if (this.terminal || this.state === "paused") return;
    if (!Number.isSafeInteger(frames) || frames < 1 || frames > 600) throw new Error("Invalid agent tick frame count.");
    if (this.settings.maxSeconds !== null && Date.now() - this.startedAt >= this.settings.maxSeconds * 1000) { this.stop("Session time limit reached."); return; }
    if (this.active) {
      const active = this.active;
      const held = Math.min(frames, active.remaining);
      if (held) { this.emulator.advance({ buttons: active.action.buttons, frames: held }); active.remaining -= held; frames -= held; }
      const released = Math.min(frames, active.release);
      if (released) { this.emulator.advance({ buttons: [], frames: released }); active.release -= released; frames -= released; }
      if (!active.remaining && !active.release) {
        this.finishAction(false); this.active = undefined; this.state = "idle";
        const exhausted = this.exhaustedLimit();
        if (exhausted) this.stop(exhausted);
      }
      if (!continuous || this.active || this.terminal) return;
    }
    if (this.pending) {
      if (continuous && frames) this.emulator.advance({ buttons: [], frames });
      return;
    }
    const exhausted = this.exhaustedLimit();
    if (exhausted) { this.stop(exhausted); return; }
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
    if (continuous && frames) this.emulator.advance({ buttons: [], frames });
  }

  async waitForPending(): Promise<void> { await this.pending; }

  private async choose(signal: AbortSignal, generation: number): Promise<void> {
    const frame = this.emulator.captureFrame();
    const hash = createHash("sha256").update(frame.pixels).digest("hex");
    const objectives = this.settings.objectives;
    const observation = await this.options.observer.observe(frame, this.previous, objectives, signal);
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
    const context = { objectives, console: this.emulator.descriptor.consoleId,
      frame: frame.number, observation: this.observation, unchangedScreens: this.unchangedScreens,
      history: [...this.history], feedback: this.feedback.observe(this.gameState, hash, this.history),
      actions, ...(this.gameState ? { gameState: structuredClone(this.gameState) } : {}) };
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
    const executionFrame = this.emulator.captureFrame();
    let beforeState = this.gameState;
    if (executionFrame.number !== frame.number) {
      const snapshot = this.options.observer.readSnapshot?.(executionFrame);
      if (snapshot) validateGameState(snapshot.state, executionFrame.number);
      beforeState = snapshot ? structuredClone(snapshot.state) : undefined;
      const current = snapshot?.actions ?? this.options.observer.availableActions?.(executionFrame) ?? actions;
      validateAgentActions(current, this.emulator.descriptor.buttons);
      const available = current.find((candidate) => candidate.id === action.id);
      if (!available || available.stop !== action.stop || available.frames !== action.frames ||
          available.buttons.length !== action.buttons.length || !available.buttons.every((button) => action.buttons.includes(button))) {
        const warning = `Action ${action.id} is no longer available at frame ${this.emulator.frameNumber}. Its response was discarded; a fresh decision is needed.`;
        this.updateExchange({ warnings: [...this.exchange!.warnings, warning].slice(-8) });
        this.completedExchange = this.exchange;
        const data = { actionId: action.id, observedFrame: frame.number, currentFrame: this.emulator.frameNumber, reason: "Action availability changed." };
        this.record({ type: "decision-discarded", ...data });
        this.diagnose("info", "decision-discarded", data);
        this.state = "idle";
        const exhausted = this.exhaustedLimit();
        if (exhausted) this.stop(exhausted);
        return;
      }
    }
    if (action.stop) { this.stop("Jev requested stop. Objective completion is unverified."); return; }
    this.active = { action, fromFrame: executionFrame.number, remaining: action.frames, release: action.buttons.length ? 4 : 0,
      screenHash: createHash("sha256").update(executionFrame.pixels).digest("hex"), beforeState };
    this.state = "acting";
    this.diagnose("info", "action-started", { actionId: action.id, buttons: action.buttons,
      frames: action.frames, releaseFrames: this.active.release, observedFrame: frame.number, executionFrame: this.active.fromFrame });
  }

  private finishAction(interrupted: boolean): void {
    if (!this.active) return;
    let result: ActionRecord["result"];
    if (!interrupted) {
      const frame = this.emulator.captureFrame();
      const snapshot = this.options.observer.readSnapshot?.(frame);
      if (snapshot) validateGameState(snapshot.state, frame.number);
      result = actionResult(frame.number, this.active.screenHash !== createHash("sha256").update(frame.pixels).digest("hex"),
        this.active.beforeState, snapshot?.state);
    }
    const record: ActionRecord = { actionId: this.active.action.id, fromFrame: this.active.fromFrame,
      toFrame: this.emulator.frameNumber, observation: this.observation.slice(0, 1500), interrupted, ...(result ? { result } : {}) };
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
  private exhaustedLimit(): string | null {
    if (this.settings.maxSeconds !== null && Date.now() - this.startedAt >= this.settings.maxSeconds * 1000) return "Session time limit reached.";
    if (this.settings.maxDecisions !== null && this.decisions >= this.settings.maxDecisions) return "Decision limit reached.";
    if (this.options.budget.limits.maxRequests !== null && this.options.budget.requests >= this.options.budget.limits.maxRequests) return "Model request limit reached.";
    return null;
  }
  private scheduleDeadline(): void {
    clearTimeout(this.deadlineTimer); this.deadlineTimer = undefined;
    if (this.settings.maxSeconds === null || this.terminal) return;
    const remaining = this.settings.maxSeconds * 1000 - (Date.now() - this.startedAt);
    this.deadlineTimer = setTimeout(() => {
      if (this.settings.maxSeconds !== null && Date.now() - this.startedAt >= this.settings.maxSeconds * 1000) this.stop("Session time limit reached.");
    }, Math.max(0, remaining));
    this.deadlineTimer.unref();
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

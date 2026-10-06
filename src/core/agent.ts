import type { Frame } from "./emulator.js";

export type DecisionProviderId = "typesafe" | "gateway" | "mock";
export type VisionProviderId = "none" | "gateway" | "mock";

/** Provider selection contains public identifiers only; credentials stay on the server. */
export interface PlayerSelection {
  readonly mode: "manual" | "agent";
  readonly decisionProvider: DecisionProviderId;
  readonly visionProvider: VisionProviderId;
  readonly decisionModel: string;
  readonly visionModel: string;
}

export interface Objectives {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly milestones: readonly string[];
}

/** Null disables a session ceiling; individual actions and HTTP requests remain bounded. */
export interface AgentSettings {
  readonly objectives: Objectives;
  readonly maxDecisions: number | null;
  readonly maxRequests: number | null;
  readonly maxSeconds: number | null;
  readonly actionFrames: number;
}

export interface AgentAction {
  readonly id: string;
  readonly description: string;
  readonly buttons: readonly string[];
  readonly frames: number;
  readonly stop: boolean;
  /** Optional profile-owned semantic context; a late response must still match it. */
  readonly availabilityKey?: string;
  /** A reader-owned executor implements this offered action within its frame ceiling. */
  readonly execution?: "profile";
}

export type ActionExecutionStep =
  | { readonly done: false; readonly buttons: readonly string[] }
  | { readonly done: true; readonly reason: string };
/** Mechanical execution of a model-selected target; cannot select a different target. */
export interface GameActionExecution {
  next(): ActionExecutionStep;
  finish?(reason: string): void;
}

export interface ModelUsage { readonly inputTokens: number; readonly outputTokens: number }
export type StateValue = string | number | boolean;
/** Profile-owned evidence about the current choices; never executable instructions. */
export interface GameDecisionSupport {
  /** Immediate profile-owned task for the current choice; supplied objectives remain authoritative. */
  readonly decisionGoal?: string;
  readonly facts: readonly string[];
  readonly actionFacts: Readonly<Record<string, readonly string[]>>;
}
export interface GameState {
  readonly source: string;
  readonly frame: number;
  readonly values: Readonly<Record<string, StateValue>>;
  readonly descriptions: Readonly<Record<string, string>>;
  readonly decisionSupport?: GameDecisionSupport;
}
export interface StateSnapshot {
  readonly state: GameState;
  readonly actions: readonly AgentAction[];
}
export interface GameStateProvider {
  readonly id: string;
  readonly defaultObjectives?: Objectives | undefined;
  read(frame: Frame): StateSnapshot;
  reset?(): void;
  setActionFrames?(frames: number): void;
  setObjectives?(objectives: Objectives): void;
  createExecution?(action: AgentAction): GameActionExecution;
  shouldWait?(frame: Frame): boolean;
  onActionComplete?(event: CompletedGameAction): void;
}
export interface VisualObservation { readonly text: string; readonly model: string; readonly usage: ModelUsage }
export interface Observation extends VisualObservation {
  readonly gameState?: GameState;
  readonly actions?: readonly AgentAction[];
}
export interface Decision {
  readonly actionId: string;
  readonly confidence: number | null;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly model: string;
  readonly usage: ModelUsage;
}
export interface ActionRecord {
  readonly actionId: string;
  readonly fromFrame: number;
  readonly toFrame: number;
  readonly observation: string;
  readonly interrupted: boolean;
  readonly result?: ActionResult;
  readonly executionReason?: string;
}
/** Actual completed execution evidence, for optional profile-owned decision memory. */
export interface CompletedGameAction {
  readonly action: AgentAction;
  readonly record: ActionRecord;
  readonly before?: GameState;
  readonly after?: GameState;
}
/** Changes observed at action completion are evidence, not proof of causation or goal progress. */
export interface ActionResult {
  readonly frame: number;
  readonly screenChanged: boolean;
  readonly stateChanged: boolean | null;
  readonly changedFieldCount: number;
  readonly changes: readonly { readonly field: string; readonly before: StateValue | null; readonly after: StateValue | null }[];
}
export interface DecisionFeedback {
  readonly basis: "structured-state" | "screen";
  readonly windowObservations: number;
  readonly repeatedStateVisits: number;
  readonly consecutiveUnchangedStates: number;
  readonly consecutiveActionsWithoutChange: number;
  readonly repeatedActionCycle: readonly string[];
  readonly cycleRepetitions: number;
  readonly stableFields: Readonly<Record<string, StateValue>>;
}
export interface DecisionContext {
  readonly objectives: Objectives;
  readonly console: string;
  readonly frame: number;
  readonly observation: string;
  readonly gameState?: GameState;
  readonly unchangedScreens: number;
  readonly history: readonly ActionRecord[];
  readonly feedback?: DecisionFeedback;
  readonly actions: readonly AgentAction[];
}
export interface ObservationProvider {
  readonly kind?: "state" | "vision" | "mock";
  observe(frame: Frame, previous: Frame | undefined, objectives: Objectives, signal: AbortSignal): Promise<Observation>;
  /** Synchronous local action availability, without another model request or frame advancement. */
  availableActions?(frame: Frame): readonly AgentAction[];
  /** Capture local state and actions synchronously, including when visual perception is remote. */
  readSnapshot?(frame: Frame): StateSnapshot;
  reset?(): void;
  setActionFrames?(frames: number): void;
  setObjectives?(objectives: Objectives): void;
  createExecution?(action: AgentAction): GameActionExecution;
  /** A bounded local settle, without requesting perception or a gameplay decision. */
  shouldWait?(frame: Frame): boolean;
  onActionComplete?(event: CompletedGameAction): void;
}
/** Visual perception cannot supply controller actions or overwrite memory-derived state. */
export interface VisionProvider {
  observe(frame: Frame, previous: Frame | undefined, objectives: Objectives, signal: AbortSignal): Promise<VisualObservation>;
}
export interface DecisionProvider {
  decide(context: DecisionContext, signal: AbortSignal, inspect?: DecisionInspectionSink): Promise<Decision>;
}

export type DecisionInspectionEvent =
  | { readonly type: "request" | "response"; readonly data: Readonly<Record<string, unknown>> }
  | { readonly type: "warning"; readonly message: string };
export type DecisionInspectionSink = (event: DecisionInspectionEvent) => void;

/** One bounded request/response pair. Transport headers and credentials are never included. */
export interface DecisionExchange {
  readonly id: number;
  readonly frame: number;
  readonly provider: DecisionProviderId;
  readonly status: "pending" | "complete" | "error" | "cancelled";
  readonly request: Readonly<Record<string, unknown>>;
  readonly response: Readonly<Record<string, unknown>> | null;
  readonly decision: Readonly<Record<string, unknown>> | null;
  readonly warnings: readonly string[];
  readonly error: string | null;
  readonly durationMs: number | null;
}

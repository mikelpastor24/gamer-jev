import type { Frame } from "./emulator.js";

export type DecisionProviderId = "typesafe" | "gateway" | "mock";
export type VisionProviderId = "none" | "gateway" | "mock";

export interface Objectives {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly milestones: readonly string[];
}

export interface AgentAction {
  readonly id: string;
  readonly description: string;
  readonly buttons: readonly string[];
  readonly frames: number;
  readonly stop: boolean;
}

export interface ModelUsage { readonly inputTokens: number; readonly outputTokens: number }
export type StateValue = string | number | boolean;
export interface GameState {
  readonly source: string;
  readonly frame: number;
  readonly values: Readonly<Record<string, StateValue>>;
  readonly descriptions: Readonly<Record<string, string>>;
}
export interface StateSnapshot {
  readonly state: GameState;
  readonly actions: readonly AgentAction[];
}
export interface GameStateProvider {
  readonly id: string;
  read(frame: Frame): StateSnapshot;
  reset?(): void;
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
}
export interface DecisionContext {
  readonly objectives: Objectives;
  readonly console: string;
  readonly frame: number;
  readonly observation: string;
  readonly gameState?: GameState;
  readonly unchangedScreens: number;
  readonly history: readonly ActionRecord[];
  readonly actions: readonly AgentAction[];
}
export interface ObservationProvider {
  readonly kind?: "state" | "vision" | "mock";
  observe(frame: Frame, previous: Frame | undefined, objectives: Objectives, signal: AbortSignal): Promise<Observation>;
  reset?(): void;
}
/** Visual perception cannot supply controller actions or overwrite memory-derived state. */
export interface VisionProvider {
  observe(frame: Frame, previous: Frame | undefined, objectives: Objectives, signal: AbortSignal): Promise<VisualObservation>;
}
export interface DecisionProvider {
  decide(context: DecisionContext, signal: AbortSignal): Promise<Decision>;
}

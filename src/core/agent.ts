import type { Frame } from "./emulator.js";

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
export interface Observation { readonly text: string; readonly model: string; readonly usage: ModelUsage }
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
  readonly unchangedScreens: number;
  readonly history: readonly ActionRecord[];
  readonly actions: readonly AgentAction[];
}
export interface ObservationProvider {
  observe(frame: Frame, previous: Frame | undefined, objectives: Objectives, signal: AbortSignal): Promise<Observation>;
}
export interface DecisionProvider {
  decide(context: DecisionContext, signal: AbortSignal): Promise<Decision>;
}

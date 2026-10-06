import type { AgentAction, CompletedGameAction, GameActionExecution, GameState, GameDecisionSupport, Objectives, StateValue } from "./agent.js";
import type { MemoryReader, RomReader } from "./emulator.js";

export interface GameReaderDescriptor {
  readonly id: string;
  readonly name: string;
  readonly consoleId: string;
  /** Exact supported ROM revisions; filenames and titles do not identify a memory layout. */
  readonly romSha256: readonly string[];
}

export interface GameStateData {
  readonly values: Readonly<Record<string, StateValue>>;
  readonly descriptions: Readonly<Record<string, string>>;
  readonly decisionSupport?: GameDecisionSupport;
}

export type GameReaderMemory = MemoryReader & Partial<RomReader> & { readonly romByteLength?: number };

/** Strategy for one game or compatible ROM family. No provider or emulator-core access. */
export interface GameReader {
  readonly descriptor: GameReaderDescriptor;
  /** Editable guidance for a new session; evidence checks belong to the profile. */
  readonly defaultObjectives?: Objectives | undefined;
  readState(memory: GameReaderMemory): GameStateData;
  availableActions(state: GameState, controllerActions: readonly AgentAction[]): readonly AgentAction[];
  /** Invalidate optional caches after cartridge reset or checkpoint restore. */
  reset?(): void;
  /** Interpret recognized supplied objectives without replacing the user's goal or constraints. */
  setObjectives?(objectives: Objectives): void;
  /** Fresh read-only execution of an offered model-selected action. The runner advances frames. */
  createExecution?(memory: GameReaderMemory, action: AgentAction): GameActionExecution;
  /** Mechanical settling only; the runner bounds neutral frames before a fresh decision. */
  shouldWait?(state: GameStateData, frame: number): boolean;
  /** Retain bounded observed outcomes; this callback cannot advance the emulator or choose another action. */
  onActionComplete?(event: CompletedGameAction): void;
}

export interface GameReaderRegistration {
  readonly descriptor: GameReaderDescriptor;
  /** Each session gets its own strategy instance. */
  create(): GameReader;
}

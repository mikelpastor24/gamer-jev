import type { AgentAction, GameState, StateValue } from "./agent.js";
import type { MemoryReader } from "./emulator.js";

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
}

/** Strategy for one game or compatible ROM family. No provider or emulator-core access. */
export interface GameReader {
  readonly descriptor: GameReaderDescriptor;
  readState(memory: MemoryReader): GameStateData;
  availableActions(state: GameState, controllerActions: readonly AgentAction[]): readonly AgentAction[];
  /** Invalidate optional caches after cartridge reset or checkpoint restore. */
  reset?(): void;
}

export interface GameReaderRegistration {
  readonly descriptor: GameReaderDescriptor;
  /** Each session gets its own strategy instance. */
  create(): GameReader;
}

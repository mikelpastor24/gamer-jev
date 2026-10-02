import type { GameReader, GameReaderDescriptor, GameReaderRegistration } from "../core/game-reader.js";
import type { GameState, GameStateProvider } from "../core/agent.js";
import type { Emulator } from "../core/emulator.js";
import { hasMemory } from "../core/emulator.js";
import { controllerActions, validateAgentActions } from "../core/actions.js";
import { validateGameState } from "../core/game-state.js";
import type { DiagnosticSink } from "../core/diagnostics.js";


function validateDescriptor(descriptor: GameReaderDescriptor): void {
  if (!descriptor || !/^[a-z][a-z0-9-]{0,63}$/.test(descriptor.id) || !descriptor.name?.trim() || descriptor.name.length > 100 ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(descriptor.consoleId) || !Array.isArray(descriptor.romSha256) ||
      descriptor.romSha256.length < 1 || descriptor.romSha256.length > 32 || descriptor.romSha256.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("Game readers require an ID, console, name, and exact supported ROM hashes.");
  }
}

export function bindGameReader(reader: GameReader, emulator: Emulator, actionFrames: number, diagnostics?: DiagnosticSink): GameStateProvider {
  validateDescriptor(reader.descriptor);
  if (reader.descriptor.consoleId !== emulator.descriptor.consoleId || !reader.descriptor.romSha256.includes(emulator.rom.sha256)) {
    throw new Error(`Game reader ${reader.descriptor.id} is incompatible with this console or ROM revision.`);
  }
  if (!hasMemory(emulator)) throw new Error("This console adapter does not support memory-based game readers.");
  let defaults = controllerActions(emulator.descriptor.buttons, actionFrames);
  const memory = Object.freeze({ readMemory: (address: number, length: number) => emulator.readMemory(address, length) });
  let previous = "";
  diagnostics?.({ component: "game-reader", level: "info", event: "bound", frame: emulator.frameNumber,
    data: { reader: reader.descriptor.id, console: reader.descriptor.consoleId, romSha256: emulator.rom.sha256 } });
  return { id: reader.descriptor.id, setActionFrames(frames) {
    defaults = controllerActions(emulator.descriptor.buttons, frames);
  }, reset() {
    previous = "";
    reader.reset?.();
    diagnostics?.({ component: "game-reader", level: "info", event: "reset", frame: emulator.frameNumber, data: { reader: reader.descriptor.id } });
  }, read(frame) {
    let stage = "frame-validation";
    const started = performance.now();
    try {
      if (frame.number !== emulator.frameNumber) throw new Error("Cannot read game state for a stale emulator frame.");
      stage = "read-state";
      const data = reader.readState(memory);
      const state: GameState = { source: reader.descriptor.id, frame: frame.number,
        values: { ...data.values }, descriptions: { ...data.descriptions } };
      stage = "validate-state";
      validateGameState(state, frame.number);
      stage = "available-actions";
      const actions = reader.availableActions(structuredClone(state), structuredClone(defaults));
      stage = "validate-actions";
      validateAgentActions(actions, emulator.descriptor.buttons);
      if (diagnostics) {
        const fingerprint = JSON.stringify({ values: state.values, descriptions: state.descriptions, actions });
        if (fingerprint !== previous) {
          previous = fingerprint;
          diagnostics({ component: "game-reader", level: "debug", event: "state-read", frame: frame.number, data: {
            reader: reader.descriptor.id, durationMs: Number((performance.now() - started).toFixed(3)),
            state, actions,
          } });
        }
      }
      return { state, actions: structuredClone(actions) };
    } catch (error: unknown) {
      diagnostics?.({ component: "game-reader", level: "error", event: "read-failed", frame: frame.number,
        data: { reader: reader.descriptor.id, stage, reason: error instanceof Error ? error.message.slice(0, 1000) : "Game reader failed." } });
      throw error;
    }
  } };
}

export class GameReaderRegistry {
  private readonly readers = new Map<string, GameReaderRegistration>();

  register(registration: GameReaderRegistration): void {
    validateDescriptor(registration.descriptor);
    if (this.readers.has(registration.descriptor.id)) throw new Error(`Game reader ${registration.descriptor.id} is already registered.`);
    this.readers.set(registration.descriptor.id, { descriptor: structuredClone(registration.descriptor), create: registration.create });
  }

  list(): readonly GameReaderDescriptor[] { return [...this.readers.values()].map((entry) => structuredClone(entry.descriptor)); }

  createFor(emulator: Emulator, actionFrames: number, id?: string, diagnostics?: DiagnosticSink): GameStateProvider | undefined {
    const candidates = id === undefined ? [...this.readers.values()].filter((entry) =>
      entry.descriptor.consoleId === emulator.descriptor.consoleId && entry.descriptor.romSha256.includes(emulator.rom.sha256)) : [this.readers.get(id)];
    if (id !== undefined && !candidates[0]) throw new Error(`Unknown game reader: ${id}. Supply a registered ID or a JSON profile path.`);
    if (candidates.length > 1) throw new Error("Multiple game readers support this ROM. Select one with --profile <id>.");
    const entry = candidates[0];
    if (!entry) return undefined;
    const reader = entry.create();
    if (reader.descriptor.id !== entry.descriptor.id || reader.descriptor.consoleId !== entry.descriptor.consoleId ||
        reader.descriptor.name !== entry.descriptor.name || reader.descriptor.romSha256.length !== entry.descriptor.romSha256.length ||
        !reader.descriptor.romSha256.every((hash) => entry.descriptor.romSha256.includes(hash))) throw new Error("The game-reader factory returned a different descriptor.");
    return bindGameReader(reader, emulator, actionFrames, diagnostics);
  }
}

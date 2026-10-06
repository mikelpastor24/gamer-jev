import { createHash } from "node:crypto";
import type { GameStateProvider, ObservationProvider } from "../core/agent.js";
import type { Emulator } from "../core/emulator.js";
import { controllerActions } from "../core/actions.js";

/** Metadata is useful context for vision, but does not interpret a game's mechanics. */
export function createEmulatorStateProvider(emulator: Emulator, actionFrames: number): GameStateProvider {
  let actions = controllerActions(emulator.descriptor.buttons, actionFrames);
  return { id: "emulator", setActionFrames(frames) { actions = controllerActions(emulator.descriptor.buttons, frames); }, read(frame) {
    if (frame.number !== emulator.frameNumber) throw new Error("Cannot combine state and a screenshot from different frames.");
    return { state: { source: "emulator", frame: frame.number, values: {
      console: emulator.descriptor.consoleId, romTitle: emulator.rom.title,
      screenWidth: frame.width, screenHeight: frame.height,
      screenHash: createHash("sha256").update(frame.pixels).digest("hex"),
    }, descriptions: { screenHash: "A pixel fingerprint, not an interpretation of the game. No semantic memory profile is configured." } }, actions };
  } };
}

export function createStateObserver(provider: GameStateProvider): ObservationProvider {
  return { kind: "state", readSnapshot(frame) { return provider.read(frame); }, availableActions(frame) { return provider.read(frame).actions; },
    ...(provider.createExecution ? { createExecution: (action) => provider.createExecution!(action) } : {}),
    ...(provider.shouldWait ? { shouldWait: (frame) => provider.shouldWait!(frame) } : {}),
    ...(provider.onActionComplete ? { onActionComplete: (event) => provider.onActionComplete!(event) } : {}),
    setObjectives(objectives) { provider.setObjectives?.(objectives); },
    reset() { provider.reset?.(); }, setActionFrames(frames) { provider.setActionFrames?.(frames); }, async observe(frame, _previous, _objectives, signal) {
    signal.throwIfAborted();
    const snapshot = provider.read(frame);
    return { text: `Structured game state from ${snapshot.state.source} (full values in gameState): ${JSON.stringify(snapshot.state.values).slice(0, 5700)}`,
      model: "local-state", usage: { inputTokens: 0, outputTokens: 0 },
      gameState: snapshot.state, actions: snapshot.actions };
  } };
}

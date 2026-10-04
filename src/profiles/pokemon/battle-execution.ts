import type { GameActionExecution } from "../../core/agent.js";

export interface PokemonMoveExecutionState {
  readonly context: string;
  readonly menu: string;
  readonly selectedSlot: number;
  readonly usableSlots: readonly number[];
}

/** Move only to the slot chosen by Jev, then send one confirmation pulse. */
export function pokemonMoveExecution(slot: number, read: () => PokemonMoveExecutionState | undefined, pulseFrames: number): GameActionExecution {
  const initial = read();
  if (!initial || initial.menu !== "moves" || !initial.usableSlots.includes(slot)) throw new Error("The selected battle move is no longer available.");
  let held = 0, release = 0, button = "", confirmed = false, frames = 0;
  return { next() {
    if (++frames > 600) return { done: true, reason: "Battle move execution reached its frame ceiling; reassess the menu." };
    const current = read();
    if (!current || current.context !== initial.context || !current.usableSlots.includes(slot)) {
      return { done: true, reason: "Battle actors, moves, PP, or disable state changed; reassess the selected move." };
    }
    if (current.menu !== "moves" && current.menu !== "moves_pending") return { done: true, reason: "The move menu closed; reassess the battle." };
    if (release) { release--; return { done: false, buttons: [] }; }
    if (confirmed && !held) return { done: true, reason: "Selected move confirmation sent; reassess its observed result." };
    // Printing briefly changes the menu index. Do not interpret that as a new selection.
    if (current.menu === "moves_pending") { held = 0; return { done: false, buttons: [] }; }
    if (!held) {
      button = current.selectedSlot === slot ? "A" : current.selectedSlot < slot ? "DOWN" : "UP";
      confirmed = button === "A";
      held = Math.max(1, Math.min(8, pulseFrames));
    }
    held--;
    if (!held) release = 4;
    return { done: false, buttons: [button] };
  } };
}

import type { GameActionExecution } from "../../core/agent.js";

export interface PokemonMoveExecutionState {
  readonly context: string;
  readonly menu: string;
  readonly selectedSlot: number;
  readonly usableSlots: readonly number[];
  readonly commandX?: number;
  readonly commandY?: number;
}

/** Open only Jev's selected POKEMON command; choosing a member is another decision. */
export function pokemonPartyMenuExecution(read: () => { readonly partyOpen: boolean; readonly battle?: PokemonMoveExecutionState | undefined }): GameActionExecution {
  const initial = read().battle;
  if (!initial || !["command", "moves"].includes(initial.menu)) throw new Error("The selected party menu is no longer available.");
  let frames = 0, release = 0, waiting = 0, confirmed = false;
  return { next() {
    if (++frames > 600) return { done: true, reason: "Party opening reached its frame ceiling." };
    const { partyOpen, battle } = read();
    if (partyOpen) return { done: true, reason: "Battle party menu opened; Jev chooses a member separately." };
    if (!battle || battle.context !== initial.context) return { done: true, reason: "Party opening battle context changed." };
    if (confirmed || !["command", "moves"].includes(battle.menu)) {
      if (++waiting > 120) return { done: true, reason: "Party command did not settle within its ceiling." };
      return { done: false, buttons: [] };
    }
    if (release) { release--; return { done: false, buttons: [] }; }
    const button = battle.menu === "moves" ? "B" : battle.commandX !== 15 ? "RIGHT" : battle.commandY !== 14 ? "UP" : "A";
    confirmed = button === "A"; release = 6;
    return { done: false, buttons: [button] };
  } };
}

/** Move only to the slot chosen by Jev, then send one confirmation pulse. */
export function pokemonMoveExecution(slot: number, read: () => PokemonMoveExecutionState | undefined, pulseFrames: number): GameActionExecution {
  const initial = read();
  if (!initial || !["moves", "command"].includes(initial.menu) || !initial.usableSlots.includes(slot)) throw new Error("The selected battle move is no longer available.");
  let held = 0, release = 0, button = "", confirmed = false, frames = 0;
  let opening = initial.menu === "command", openingConfirmed = false, waiting = 0;
  return { next() {
    if (++frames > 600) return { done: true, reason: "Battle move execution reached its frame ceiling; reassess the menu." };
    const current = read();
    if (!current || current.context !== initial.context || !current.usableSlots.includes(slot)) {
      return { done: true, reason: "Battle actors, moves, PP, or disable state changed; reassess the selected move." };
    }
    if (opening) {
      if (current.menu === "moves") { opening = false; held = 0; release = 4; }
      else {
        if (++waiting > 120) return { done: true, reason: "The selected FIGHT menu did not open within the settling ceiling." };
        if (openingConfirmed || ["moves_pending", "other"].includes(current.menu)) return { done: false, buttons: [] };
        if (current.menu !== "command" || ![9, 15].includes(current.commandX ?? 0) || ![14, 16].includes(current.commandY ?? 0)) return { done: true, reason: "The verified battle command menu changed." };
        if (held && (button === "LEFT" && current.commandX === 9 || button === "UP" && current.commandY === 14)) { held = 0; release = 4; }
        if (release) { release--; return { done: false, buttons: [] }; }
        if (!held) {
          button = current.commandX !== 9 ? "LEFT" : current.commandY !== 14 ? "UP" : "A";
          openingConfirmed = button === "A"; held = openingConfirmed ? 1 : Math.max(1, Math.min(8, pulseFrames));
        }
        held--; if (!held) release = 4;
        return { done: false, buttons: [button] };
      }
    }
    if (current.menu !== "moves" && current.menu !== "moves_pending") return { done: true, reason: "The move menu closed; reassess the battle." };
    if (held && !confirmed && current.menu === "moves" && current.selectedSlot === slot) { held = 0; release = 4; }
    if (release) { release--; return { done: false, buttons: [] }; }
    if (confirmed && !held) return { done: true, reason: "Selected move confirmation sent; reassess its observed result." };
    // Printing briefly changes the menu index. Do not interpret that as a new selection.
    if (current.menu === "moves_pending") { held = 0; return { done: false, buttons: [] }; }
    if (!held) {
      button = current.selectedSlot === slot ? "A" : current.selectedSlot < slot ? "DOWN" : "UP";
      confirmed = button === "A";
      held = confirmed ? 1 : Math.max(1, Math.min(8, pulseFrames));
    }
    held--;
    if (!held) release = 4;
    return { done: false, buttons: [button] };
  } };
}

/** Executes only Jev's selected RUN attempt; never retries a failed escape or substitutes a move. */
export function pokemonEscapeExecution(read: () => PokemonMoveExecutionState | undefined, pulseFrames: number): GameActionExecution {
  const initial = read();
  if (!initial || !["command", "moves"].includes(initial.menu)) throw new Error("The selected wild escape is no longer available.");
  let frames = 0, held = 0, release = 0, button = "", confirmed = false;
  return { next() {
    if (++frames > 600) return { done: true, reason: "Escape attempt reached its frame ceiling; reassess the battle." };
    const current = read();
    if (!current || current.context !== initial.context) return { done: true, reason: "The selected escape context changed; reassess the battle." };
    if (confirmed) return { done: true, reason: "One RUN confirmation sent; inspect whether escape succeeded." };
    if (current.menu === "moves_pending") { held = 0; return { done: false, buttons: [] }; }
    if (!["command", "moves"].includes(current.menu)) return { done: true, reason: "The selected escape menu changed." };
    if (held && (button === "B" && current.menu === "command" || current.menu === "command" &&
        (button === "RIGHT" && current.commandX === 15 || button === "DOWN" && current.commandY === 16))) { held = 0; release = 4; }
    if (release) { release--; return { done: false, buttons: [] }; }
    if (!held) {
      if (current.menu === "command" && (![9, 15].includes(current.commandX ?? 0) || ![14, 16].includes(current.commandY ?? 0))) return { done: true, reason: "The RUN command cursor is unverified." };
      button = current.menu === "moves" ? "B" : current.commandX !== 15 ? "RIGHT" : current.commandY !== 16 ? "DOWN" : "A";
      confirmed = button === "A"; held = confirmed ? 1 : Math.max(1, Math.min(8, pulseFrames));
    }
    held--; if (!held) release = 4;
    return { done: false, buttons: [button] };
  } };
}

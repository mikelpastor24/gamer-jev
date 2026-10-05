import type { GameActionExecution } from "../../core/agent.js";

export interface PokemonItemExecutionState {
  readonly context: string;
  readonly menu: "command" | "moves" | "bag" | "shop" | "quantity" | "pending" | "other";
  readonly commandX: number; readonly commandY: number;
  readonly selected: number;
  readonly slots: readonly number[];
}
export type PokemonItemTarget = { readonly kind: "bag" } | { readonly kind: "ball" | "shop"; readonly slot: number };

/** Opens the selected bag or confirms exactly the selected item, with no recovery/alternate choice. */
export function pokemonItemExecution(target: PokemonItemTarget, read: () => PokemonItemExecutionState | undefined,
  pulseFrames: number): GameActionExecution {
  const initial = read();
  const available = (state: PokemonItemExecutionState) => target.kind === "bag" ? ["command", "moves"].includes(state.menu) :
    state.menu === (target.kind === "ball" ? "bag" : "shop") && state.slots.includes(target.slot);
  if (!initial || !available(initial)) throw new Error("The selected item action is no longer available.");
  let held = 0, release = 0, frames = 0, waiting = 0, button = "", confirmed = false;
  return { next() {
    if (++frames > 600) return { done: true, reason: "Item action reached its frame ceiling; reassess the menu." };
    const current = read();
    if (!current || current.context !== initial.context) return { done: true, reason: "Battle, inventory, money, or item context changed; reassess the result." };
    if (target.kind === "bag" && current.menu === "bag") return { done: true, reason: "Battle bag opened; Jev chooses the item next." };
    if (confirmed) {
      if (target.kind !== "bag") return { done: true, reason: "Selected item confirmation sent; reassess its observed result." };
      if (++waiting > 120) return { done: true, reason: "The selected bag did not open within the settling ceiling." };
      return { done: false, buttons: [] };
    }
    if (current.menu === "pending") { held = 0; return { done: false, buttons: [] }; }
    if (!available(current)) return { done: true, reason: "The selected item menu closed or the choice became unavailable." };
    if (release) { release--; return { done: false, buttons: [] }; }
    if (!held) {
      button = target.kind === "bag" ? current.menu === "moves" ? "B" : current.commandX !== 9 ? "LEFT" :
        current.commandY !== 16 ? "DOWN" : "A" : current.selected === target.slot ? "A" : current.selected < target.slot ? "DOWN" : "UP";
      confirmed = button === "A";
      // A single confirmation frame avoids holding A into a capture message or quantity/price prompt.
      held = confirmed ? 1 : Math.max(1, Math.min(8, pulseFrames));
    }
    held--;
    if (!held) release = 6;
    return { done: false, buttons: [button] };
  } };
}

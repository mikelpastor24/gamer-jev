import type { GameActionExecution } from "../../core/agent.js";

export interface PokemonItemExecutionState {
  readonly context: string;
  readonly menu: "command" | "moves" | "bag" | "shop" | "quantity" | "pending" | "other" | "overworld" | "start" | "use";
  readonly commandX: number; readonly commandY: number;
  readonly selected: number;
  readonly slots: readonly number[];
  readonly itemRow?: number;
}
export type PokemonItemTarget = { readonly kind: "bag" | "medicine_bag" } | { readonly kind: "ball" | "shop" | "medicine"; readonly slot: number };

/** Opens the selected bag or confirms exactly the selected item, with no recovery/alternate choice. */
export function pokemonItemExecution(target: PokemonItemTarget, read: () => PokemonItemExecutionState | undefined,
  pulseFrames: number): GameActionExecution {
  const initial = read();
  const targetSlot = "slot" in target ? target.slot : undefined;
  const opening = target.kind === "bag" || target.kind === "medicine_bag";
  const available = (state: PokemonItemExecutionState) => opening ? ["command", "moves", ...(target.kind === "medicine_bag" ? ["overworld", "start"] : [])].includes(state.menu) :
    state.menu === (target.kind === "shop" ? "shop" : "bag") && state.slots.includes(targetSlot!);
  if (!initial || !available(initial)) throw new Error("The selected item action is no longer available.");
  let held = 0, release = 0, frames = 0, waiting = 0, button = "", confirmed = false, started = false;
  return { next() {
    if (++frames > 600) return { done: true, reason: "Item action reached its frame ceiling; reassess the menu." };
    const current = read();
    if (!current && target.kind === "medicine_bag" && started && ++waiting <= 120) return { done: false, buttons: [] };
    if (!current || current.context !== initial.context) return { done: true, reason: "Battle, inventory, money, or item context changed; reassess the result." };
    if (opening && current.menu === "bag") return { done: true, reason: "Player bag opened; Jev chooses the item next." };
    if (confirmed) {
      if (!opening) return { done: true, reason: "Selected item confirmation sent; reassess its observed result." };
      if (++waiting > 120) return { done: true, reason: "The selected bag did not open within the settling ceiling." };
      return { done: false, buttons: [] };
    }
    if (current.menu === "pending") { held = 0; return { done: false, buttons: [] }; }
    if (target.kind === "medicine_bag" && started && current.menu === "overworld") {
      if (++waiting > 120) return { done: true, reason: "START did not open within the settling ceiling." };
      return { done: false, buttons: [] };
    }
    if (!available(current)) return { done: true, reason: "The selected item menu closed or the choice became unavailable." };
    if (held && (opening ? current.menu === "start" && current.selected === current.itemRow || current.menu === "command" &&
        (button === "LEFT" && current.commandX === 9 || button === "DOWN" && current.commandY === 16) : current.selected === targetSlot)) { held = 0; release = 6; }
    if (release) { release--; return { done: false, buttons: [] }; }
    if (!held) {
      button = opening ? current.menu === "overworld" ? "START" : current.menu === "start" ?
        current.selected === current.itemRow ? "A" : current.selected < current.itemRow! ? "DOWN" : "UP" :
        current.menu === "moves" ? "B" : current.commandX !== 9 ? "LEFT" : current.commandY !== 16 ? "DOWN" : "A" :
        current.selected === targetSlot ? "A" : current.selected < targetSlot! ? "DOWN" : "UP";
      confirmed = button === "A";
      started ||= button === "START" || confirmed;
      // A single confirmation frame avoids holding A into a capture message or quantity/price prompt.
      held = confirmed || button === "START" || button === "B" ? 1 : Math.max(1, Math.min(8, pulseFrames));
    }
    held--;
    if (!held) release = 6;
    return { done: false, buttons: [button] };
  } };
}

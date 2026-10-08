import type { GameActionExecution } from "../../core/agent.js";

export interface PokemonNamingState {
  readonly context: string; readonly entered: string; readonly x: number; readonly row: number;
  readonly upper: boolean; readonly names: readonly string[];
}
/** Type exactly Jev's selected offered name, confirming each key once and then START once. */
export function pokemonNamingExecution(name: string, read: () => PokemonNamingState | undefined): GameActionExecution {
  const initial = read();
  if (!initial || !initial.names.includes(name)) throw new Error("The selected name is no longer available.");
  let frames = 0, release = 0, pending: string | undefined, waiting = 0, submitted = false;
  return { next() {
    if (++frames > 600) return { done: true, reason: "Naming reached its frame ceiling; reassess the same chosen name." };
    const state = read();
    if (submitted) return { done: true, reason: "Selected name submission sent once; inspect the resulting nickname." };
    if (!state || state.context !== initial.context || !state.names.includes(name)) return { done: true, reason: "Naming context or offered name changed." };
    if (release > 0) { release--; return { done: false, buttons: [] }; }
    if (pending !== undefined) {
      if (state.entered !== pending) {
        if (++waiting > 120) return { done: true, reason: "Naming confirmation did not produce the expected text." };
        return { done: false, buttons: [] };
      }
      pending = undefined; waiting = 0;
    }
    let button: string;
    if (!name.startsWith(state.entered)) { button = "B"; pending = state.entered.slice(0, -1); }
    else if (state.entered === name) { button = "START"; submitted = true; }
    else if (!state.upper) button = "SELECT";
    else {
      const code = name.charCodeAt(state.entered.length) - 65, row = Math.floor(code / 9) + 1, x = code % 9 * 2 + 1;
      if (state.row !== row) button = state.row < row ? "DOWN" : "UP";
      else if (state.x !== x) {
        const current = (state.x - 1) / 2, target = (x - 1) / 2;
        button = (target - current + 9) % 9 <= (current - target + 9) % 9 ? "RIGHT" : "LEFT";
      } else { button = "A"; pending = state.entered + name[state.entered.length]!; }
    }
    release = 6;
    return { done: false, buttons: [button] };
  } };
}

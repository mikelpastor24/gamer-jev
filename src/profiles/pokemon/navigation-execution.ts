import type { GameActionExecution } from "../../core/agent.js";
import type { GameStateData } from "../../core/game-reader.js";

export interface PokemonRoute {
  readonly id: string;
  readonly context: string;
  readonly label: string;
  readonly length: number;
  readonly nextButtons: readonly string[];
  readonly interact: boolean;
  readonly x: number;
  readonly y: number;
  readonly destination?: number;
  readonly towardObjective: boolean;
}

export interface PokemonRouteOutcome {
  readonly closestDistance: number;
  readonly mapChanged: boolean;
}

/** A repeated partial approach is not new progress toward the same target. */
export class PokemonRouteFeedback {
  private readonly entries = new Map<string, { distance: number; attempts: number }>();
  reset(): void { this.entries.clear(); }
  attempts(route: PokemonRoute): number { return this.entries.get(`${route.context}:${route.id}`)?.attempts ?? 0; }
  remember(route: PokemonRoute, outcome: PokemonRouteOutcome): void {
    const key = `${route.context}:${route.id}`;
    if (outcome.mapChanged) { this.entries.delete(key); return; }
    const previous = this.entries.get(key) ?? { distance: route.length, attempts: 0 };
    const distance = Math.min(route.length, outcome.closestDistance);
    if (!this.entries.has(key) && this.entries.size >= 32) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { distance: Math.min(distance, previous.distance),
      attempts: distance < previous.distance ? 0 : Math.min(999, previous.attempts + 1) });
  }
}

/** Replans only the destination selected by Jev. Reads state; the runner advances frames. */
export function pokemonNavigationExecution(id: string, read: () => { state: GameStateData; route: PokemonRoute | undefined },
  pulseFrames: number, remember: (initial: PokemonRoute, outcome: PokemonRouteOutcome, reason: string) => void): GameActionExecution {
  const initial = read();
  if (!initial.route || initial.state.values.phase !== "overworld") throw new Error("The selected navigation target is no longer available.");
  const target = initial.route;
  const map = initial.state.values.mapId;
  let lastPosition = `${initial.state.values.playerX},${initial.state.values.playerY}`;
  let stagnant = 0, release = 0, held = 0, button = "", interactionSent = false, mapChanged = false;
  let closestDistance = target.length;
  let finished = false;
  return {
    next() {
      const { state, route } = read(), values = state.values;
      if (values.mapId !== map) { mapChanged = true; return { done: true, reason: "Map changed; reassess the selected destination." }; }
      if (values.phase !== "overworld") return { done: true, reason: "Dialogue, battle, menu, or script interrupted navigation." };
      if (values.controlBusy === true) return { done: true, reason: "An overworld script took control; reassess after local settling." };
      const position = `${values.playerX},${values.playerY}`;
      if (position !== lastPosition) { lastPosition = position; stagnant = 0; }
      else stagnant++;
      if (stagnant > 120) return { done: true, reason: "No settled movement toward this target; reassess obstacles or scripts." };
      if (values.movementInProgress === true) { held = 0; release = Math.max(release, 4); return { done: false, buttons: [] }; }
      if (!route) return { done: true, reason: "Selected target is no longer reachable with the current walking rules." };
      if (route.id !== id) throw new Error("Navigation cannot substitute a different target.");
      if (route.context !== target.context) return { done: true, reason: "The selected target context changed; reassess the current objective." };
      closestDistance = Math.min(closestDistance, route.length);
      if (release) { release--; return { done: false, buttons: [] }; }
      if (interactionSent && !held) return { done: true, reason: "Interaction input sent; reassess its observed result." };
      if (!held) {
        button = route.nextButtons[0] ?? "";
        if (route.length === 0 && route.interact) {
          const dx = route.x - Number(values.playerX), dy = route.y - Number(values.playerY);
          const facing = dx ? dx > 0 ? "right" : "left" : dy > 0 ? "down" : "up";
          button = values.facing === facing ? "A" : facing.toUpperCase();
          if (button === "A") interactionSent = true;
        }
        if (!button) return { done: false, buttons: [] };
        held = Math.min(8, pulseFrames);
      }
      held--;
      if (!held) release = 4;
      return { done: false, buttons: [button] };
    },
    finish(reason) {
      if (finished) return;
      finished = true;
      if (reason !== "Profile action cancelled.") remember(target, { closestDistance, mapChanged }, reason);
    },
  };
}

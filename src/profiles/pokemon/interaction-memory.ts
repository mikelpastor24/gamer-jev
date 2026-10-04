import { createHash } from "node:crypto";
import type { StateValue } from "../../core/agent.js";
import type { GameStateData } from "../../core/game-reader.js";

interface Interaction {
  readonly site: string;
  readonly label: string;
  readonly signature: string;
  readonly session: number;
  readonly text: string[];
}
interface CompletedInteraction {
  readonly count: number;
  readonly text: string;
  readonly signature: string;
  readonly stateChanged: boolean;
}

/** Bounded observation memory, not a quest script or evidence of goal completion. */
export class PokemonInteractionMemory {
  private readonly completed = new Map<string, CompletedInteraction>();
  private active: Interaction | undefined;
  private last: { readonly label: string; readonly text: string; readonly stateChanged: boolean } | undefined;
  private session = 0;

  reset(): void { this.completed.clear(); this.active = undefined; this.last = undefined; this.session = 0; }

  read(state: Readonly<Record<string, StateValue>>, eventFlags: Uint8Array): GameStateData {
    const values: Record<string, StateValue> = {};
    const descriptions: Record<string, string> = {};
    const facts: string[] = [];
    const actionFacts: Record<string, string[]> = {};
    const add = (name: string, value: StateValue, description: string) => { values[name] = value; descriptions[name] = description; };
    const positioned = state.gameStarted === true && [state.mapId, state.playerX, state.playerY].every(Number.isSafeInteger) &&
      ["up", "down", "left", "right"].includes(String(state.facing));
    const site = positioned ? `${state.mapId}:${state.playerX}:${state.playerY}:${state.facing}` : undefined;
    const label = `map ${state.mapId} at (${state.playerX},${state.playerY}), facing ${state.facing}`;
    // Ignore printing, menus, coordinates, and animation. Retain only tracked durable state.
    const tracked = Object.entries(state).filter(([name]) => /^(playerName|rivalName|money|badges|badgeCount|pokedexOwned|pokedexSeen|bagCount|bagItems|partyCount|party[1-6](Moves)?)$/.test(name));
    const signature = createHash("sha256").update(JSON.stringify(tracked.sort(([a], [b]) => a.localeCompare(b))))
      .update(eventFlags).digest("hex");
    if (site && state.dialogueActive === true && !this.active) {
      this.session = this.session === Number.MAX_SAFE_INTEGER ? 1 : this.session + 1;
      this.active = { site, label, signature, session: this.session, text: [] };
    }
    if (this.active && state.dialogueActive === true) {
      const text = String(state.screenTextBottom ?? "").replace(/\s*v\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 256);
      const previous = this.active.text.at(-1);
      if (text && text !== previous) {
        if (previous && (text.startsWith(previous) || previous.startsWith(text))) this.active.text[this.active.text.length - 1] = text.length > previous.length ? text : previous;
        else { this.active.text.push(text); if (this.active.text.length > 8) this.active.text.shift(); }
      }
    }
    // A box disappearing during a menu/transition does not prove that the conversation ended.
    if (this.active && state.phase === "overworld" && state.dialogueActive === false) {
      const interaction = this.active;
      const previous = this.completed.get(interaction.site);
      const text = interaction.text.join(" | ").slice(-256);
      const stateChanged = signature !== interaction.signature;
      this.completed.delete(interaction.site);
      if (this.completed.size === 32) this.completed.delete(this.completed.keys().next().value!);
      this.completed.set(interaction.site, { count: Math.min((previous?.count ?? 0) + 1, 999), text, signature, stateChanged });
      this.last = { label: interaction.label, text, stateChanged };
      this.active = undefined;
    }
    if (this.active) add("dialogueSession", this.active.session, "Local dialogue episode ID. Printing within an episode does not change its input context; a later conversation does.");
    if (this.last) {
      add("lastDialogueLocation", this.last.label, "Position and facing at the start of the last observed dialogue. This does not identify a specific NPC.");
      add("lastDialogueText", this.last.text, "Bounded recent text fragments from the last completed dialogue; not a complete transcript. Retained beyond the recent action history.");
      add("lastDialogueStateChanged", this.last.stateChanged, "Whether tracked event flags, party, inventory, money, badges, or Pokedex changed during the dialogue. False is not proof of no useful information or goal progress.");
      facts.push(`Last completed dialogue at ${this.last.label}. Recent text: ${this.last.text || "not captured"}. ${this.last.stateChanged ? "Tracked game state changed." : "No change observed in tracked game state; the dialogue may still provide useful information."}`.slice(0, 500));
    }
    const known = site ? this.completed.get(site) : undefined;
    if (known) {
      add("completedDialoguesHere", known.count, "Completed dialogue episodes observed from this map position and facing, capped at 999; repeat reads do not increment it. Moving actors can change who is in front.");
      add("lastDialogueHere", known.text, "Bounded recent text from the most recent completed conversation at the current position/facing. Historical evidence; the actor or game state may have changed.");
      if (known.text && known.text !== this.last?.text) facts.push(`Previous dialogue from this position/facing: ${known.text}`);
      if (state.phase === "overworld" && !known.stateChanged && known.signature === signature) {
        const warning = `Already completed ${known.count} dialogue(s) from this position/facing. The latest ended without a tracked game-state change. A starts another interaction; it does not advance the completed text. Use the information already received and consider available routes or other interactions unless the objective requires talking again. A moving actor or untracked mechanic can change the result.`;
        facts.push(warning);
        actionFacts.press_a = [warning];
      } else if (this.active && known.signature === this.active.signature) {
        facts.push(`A dialogue is active at a position/facing with ${known.count} prior completed conversation(s). Advance its remaining text, then reassess the received information and available routes after it closes.`);
      }
    }
    return { values, descriptions, decisionSupport: { facts, actionFacts } };
  }
}

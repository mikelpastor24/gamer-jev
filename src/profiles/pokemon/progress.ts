import type { Objectives, StateValue } from "../../core/agent.js";
import { pokemonObjectives } from "./objectives.js";

export interface PokemonStoryObjective {
  readonly id: string;
  readonly goal: string;
  readonly map: number;
  readonly index: number;
}

/** Original story interpretation of shared, named English Gen I event bits. */
export class PokemonStoryProgress {
  private readonly defaults: Objectives;
  private objectives: Objectives;
  private readonly visited = new Set<number>();
  constructor(private readonly yellow: boolean) {
    this.defaults = pokemonObjectives(yellow ? "pikachu" : "choice");
    this.objectives = this.defaults;
  }
  setObjectives(objectives: Objectives): void { this.objectives = structuredClone(objectives); }
  reset(): void { this.visited.clear(); }

  read(flags: Uint8Array, values: Readonly<Record<string, StateValue>>, inventory: readonly number[] = []) {
    if (values.gameStarted !== true || flags.length !== 320) return undefined;
    if (values.phase === "overworld" && values.movementInProgress !== true && values.controlBusy !== true &&
        typeof values.mapId === "number" && Number.isSafeInteger(values.mapId) && values.mapId >= 0 && values.mapId < 248) this.visited.add(values.mapId);
    const event = (bit: number) => !!(flags[bit >> 3]! & 1 << (bit & 7));
    const badge = (name: string) => String(values.badges).split(", ").includes(name);
    // These named event indices match both pinned English disassemblies; RAM bases differ.
    const metOak = event(0), starter = event(34), rival = event(35), parcel = event(57), pokedex = event(37);
    const bill = event(1372), cut = event(1504), rocketBoss = event(1703), flute = event(296);
    const scope = inventory.includes(0x48) || flute;
    const surf = event(2176), strength = event(568), silph = event(1935), champion = event(2305);
    const checks = [metOak, starter, rival, parcel, pokedex, badge("Boulder"),
      badge("Cascade") && bill, badge("Thunder") && cut,
      this.visited.has(4) || flute, badge("Rainbow") && rocketBoss && scope, flute,
      badge("Soul") && surf && strength, badge("Marsh") && silph,
      badge("Volcano"), Number(values.badgeCount) === 8, champion];
    const ids = ["meet_oak", "starter", "first_rival", "collect_parcel", "deliver_parcel", "brock", "misty_and_bill", "cut_and_surge",
      "lavender", "scope_and_erika", "poke_flute", "safari_and_koga", "silph_and_sabrina", "blaine", "eight_badges", "champion"];
    // Pick prerequisites within a combined editable milestone before its later destination.
    const maps = [12, 40, 40, 42, 40, 54, bill ? 65 : 88, cut ? 92 : 101,
      4, rocketBoss && scope ? 134 : 203, event(1231) ? 149 : 148, !surf ? 222 : !strength ? 155 : 157, silph ? 178 : 235, 166, 45,
      !event(2273) ? 245 : !event(2281) ? 246 : !event(2289) ? 247 : !event(2297) ? 113 : 120];
    const matched = this.objectives.milestones.map(text => ({ text, index: this.defaults.milestones.indexOf(text) }))
      .filter(({ index }) => index !== -1);
    const current = matched.find(({ index }) => !checks[index]);
    const objective: PokemonStoryObjective | undefined = current ? {
      id: ids[current.index]!, goal: current.text, map: maps[current.index]!, index: current.index,
    } : undefined;
    const completed = matched.filter(({ index }) => checks[index]).map(({ index }) => ids[index]!);
    return { objective, values: {
      oakEncounterCompleted: metOak, starterReceived: starter, firstRivalBattleCompleted: rival,
      parcelReceived: parcel, pokedexReceived: pokedex,
      completedStoryChecks: completed.join(", ").slice(0, 256) || "none",
      ...(objective ? { activeMilestone: objective.id, activeMilestoneGoal: objective.goal.slice(0, 256), objectiveMapId: objective.map } : {}),
    }, facts: [
      ...(objective ? [`Active supplied story milestone: ${objective.goal}`] : [matched.length ?
        "All recognized supplied story checkpoints are satisfied; other user objectives may remain." :
        "Custom milestones are not interpreted as verified story checks. Follow the supplied user goal and constraints."]),
      "Story checkpoints use named flags, badges, inventory, and an explicit Lavender arrival check. They do not verify every instruction in milestone text, battle preparation, or the full user goal. A map visit alone does not grant items or complete dialogue. User constraints take priority.",
      ...(objective?.id === "scope_and_erika" && rocketBoss && !scope ? ["The hideout boss was defeated, but the Silph Scope has not been observed in the bag. Defeating the boss alone does not collect the item; storage contents are unknown."] : []),
      ...(objective?.id === "meet_oak" && values.mapId === 0 ? [
        `Oak has not brought the player to his lab yet. Approach the north exit toward Route 1; Oak's encounter starts on row ${this.yellow ? 0 : 1}. Returning home, reading signs, or visiting the lab entrance does not trigger that encounter.`,
      ] : []),
      ...(objective?.id === "first_rival" && values.mapId === 40 ? ["With a starter received, trying to leave Oak's laboratory triggers the first rival battle; a walk toward its exit can serve this objective."] : []),
    ] };
  }
}

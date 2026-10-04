import { pokemonLocation } from "./locations.js";

interface Crossing { readonly from: number; readonly to: number }

/** Bounded settled map changes survive intervening battles and duplicate reader snapshots. */
export class PokemonTravelMemory {
  private crossings: Crossing[] = [];
  private currentMap: number | undefined;
  private evidenceKey = "";

  reset(): void { this.crossings = []; this.currentMap = undefined; this.evidenceKey = ""; }

  observe(map: number | undefined, settled: boolean, evidenceKey: string): void {
    if (evidenceKey !== this.evidenceKey) { this.reset(); this.evidenceKey = evidenceKey; }
    if (!settled || map === undefined || !Number.isSafeInteger(map) || map < 0 || map >= 248) return;
    if (this.currentMap !== undefined && this.currentMap !== map) {
      this.crossings.push({ from: this.currentMap, to: map });
      if (this.crossings.length > 32) this.crossings.shift();
    }
    this.currentMap = map;
  }

  private reversals(from: number, to: number): number {
    return this.crossings.filter((crossing, index) => {
      const previous = this.crossings[index - 1];
      return previous && crossing.from === previous.to && crossing.to === previous.from &&
        (crossing.from === from && crossing.to === to || crossing.from === to && crossing.to === from);
    }).length;
  }

  facts(map: number): readonly string[] {
    const pairs = new Set(this.crossings.filter(crossing => crossing.from === map || crossing.to === map)
      .map(crossing => crossing.from === map ? crossing.to : crossing.from));
    const repeated = [...pairs].filter(other => this.reversals(map, other) >= 2);
    if (!repeated.length) return [];
    const recent = this.crossings.slice(-5);
    const path = recent.length ? [recent[0]!.from, ...recent.map(crossing => crossing.to)].map(pokemonLocation).join(" -> ") : "";
    return [`Observed repeated return crossings involving ${pokemonLocation(map)} and ${repeated.map(pokemonLocation).join(", ")}. Recent settled maps: ${path}. No new tracked story-check, badge, bag, or party-count evidence since these crossings. Map changes alone do not verify progress; continue through a different useful exit or justify returning for the user's goal or current condition.`.slice(0, 500)];
  }

  routeFacts(from: number, to: number): readonly string[] {
    const latest = this.crossings.at(-1), count = this.crossings.filter(crossing => crossing.from === from && crossing.to === to).length;
    const reversals = this.reversals(from, to);
    const facts: string[] = [];
    if (latest?.from === to && latest.to === from) facts.push(`Returns to ${pokemonLocation(to)}, the map this visit came from. Returning can be useful, but is not onward travel through this area.`);
    if (reversals >= 2) facts.push(`${reversals} immediate return crossings observed for this map pair; ${count} previous crossings in this direction. No new tracked story-check, badge, bag, or party-count evidence. Repeating the crossing alone does not verify progress or healing.`);
    return facts;
  }
}

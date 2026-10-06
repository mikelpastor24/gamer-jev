import type { AgentAction, CompletedGameAction, GameActionExecution, StateValue } from "../../core/agent.js";

export type PokemonFocus = "progress" | "shop" | "heal" | "train" | "catch" | "explore";
const descriptions: Readonly<Record<PokemonFocus, string>> = {
  progress: "Pursue the supplied story milestone. At its destination, interact with the relevant person/object; arriving alone does not complete it. Respect preparation constraints.",
  shop: "Obtain useful supplies at a Poke Mart. Enter, approach the clerk, choose items and confirm purchases separately. Arriving at a Mart is not shopping.",
  heal: "Restore the party at a Pokemon Center. Enter and interact with the nurse; arriving alone does not heal anyone.",
  train: "Train the party through wild encounters in reachable grass. Choose moves and healing needs separately. Observed level gains can be evidence for this focus, not story completion.",
  catch: "Seek useful wild captures in reachable grass. Select a target and a capture ball separately. Respect party/storage limits and avoid knocking out the desired target.",
  explore: "Investigate a different useful person, object, exit or area. Use observed outcomes; repeated arrivals and menu toggles alone do not complete the goal.",
};

/** Jev-selected purpose persists across maps and battles. Reads never count as decisions. */
export class PokemonFocusMemory {
  private focus: PokemonFocus | undefined;
  private key = "";
  private inventory = "";
  private reason = "Choose a purpose before selecting the next destination.";
  private offered: readonly PokemonFocus[] = [];
  private age = 0;
  private stagnant = 0;
  private gained = false;
  private revision = 0;
  private readonly best = new Map<PokemonFocus, readonly [number, number]>();
  private readonly attempts = new Map<string, number>();
  private readonly selections = new Map<PokemonFocus, number>();
  private lastTarget = "";
  private health = "";
  private healBefore = "";
  private training: number | undefined;
  get current(): PokemonFocus | undefined { return this.focus; }
  get needsChoice(): boolean { return this.focus === undefined; }
  get version(): number { return this.revision; }
  requireReview(reason: string): void { this.reconsider(reason); }

  reset(): void {
    this.focus = undefined; this.key = ""; this.inventory = ""; this.age = 0; this.stagnant = 0; this.gained = false;
    this.best.clear(); this.attempts.clear(); this.selections.clear(); this.offered = []; this.lastTarget = ""; this.revision++;
    this.health = ""; this.healBefore = ""; this.training = undefined;
    this.reason = "Choose a purpose before selecting the next destination.";
  }
  observe(state: Readonly<Record<string, StateValue>>, completedChecks: string): void {
    if (state.gameStarted !== true) return;
    const party = Array.from({ length: Math.min(Number(state.partyCount) || 0, 6) }, (_, index) => String(state[`party${index + 1}`] ?? "unknown"));
    const hp = party.map(mon => mon.match(/HP=(\d+)\/(\d+)/)).filter(match => match !== null);
    const danger = hp.length === party.length && party.length > 0 && hp.reduce((sum, m) => sum + Number(m[1]), 0) < hp.reduce((sum, m) => sum + Number(m[2]), 0) / 4;
    const signature = JSON.stringify([completedChecks, state.badges, state.partyCount, state.pokedexOwned,
      party.map(mon => mon.match(/speciesId=(\d+)/)?.[1] ?? "unknown"), hp.map(m => Number(m[1]) === 0), state.preparationHealthKey ?? danger]);
    const inventory = String(state.bagItems ?? "");
    const changedInventory = inventory !== this.inventory;
    this.inventory = inventory;
    if (signature === this.key && changedInventory && this.focus === "catch") {
      // Buying/using supplies is a stage of the same model-selected capture purpose.
      this.best.clear(); this.stagnant = 0; this.gained = true; this.revision++;
    } else if (signature !== this.key || changedInventory) {
      this.key = signature; this.focus = undefined; this.best.clear(); this.attempts.clear(); this.selections.clear();
      this.age = 0; this.stagnant = 0; this.gained = false; this.lastTarget = ""; this.revision++;
      this.reason = "Story, inventory, team, or critical health evidence changed; choose a purpose using the current constraints.";
    }
    this.health = JSON.stringify(party.map((mon, index) => [mon, state[`party${index + 1}Moves`]]));
    const levels = party.map(mon => Number(mon.match(/level=(\d+)/)?.[1]));
    const training = levels.length > 0 && levels.every(level => Number.isInteger(level) && level >= 1 && level <= 100) ? levels.reduce((sum, level) => sum + level, 0) : undefined;
    if (this.focus === "train" && this.training !== undefined && training !== undefined && training > this.training) this.gained = true;
    this.training = training;
    if (this.focus === "heal" && this.health !== this.healBefore && hp.length === party.length && party.length > 0 && hp.every(m => m[1] === m[2]) && (state.partyRestored === true || state.partyRestored === undefined && party.every(mon => mon.endsWith("healthy") || mon.endsWith("no status condition")))) {
      this.reconsider("Full party HP and healthy statuses are observed. Review remaining PP needs and choose the next purpose; this does not verify every healing mechanic.");
    }
  }
  distance(areas: number | undefined, local: number | undefined): void {
    if (!this.focus || areas === undefined) return;
    const previous = this.best.get(this.focus), value = [areas, local ?? Infinity] as const;
    if (!previous) this.best.set(this.focus, value);
    else if (value[0] < previous[0] || value[0] === previous[0] && value[1] < previous[1]) {
      this.best.set(this.focus, value); this.gained = true;
    }
  }
  choices(values: Readonly<Record<string, StateValue>>, offered: readonly PokemonFocus[], notes: (focus: PokemonFocus) => string = () => ""): readonly AgentAction[] {
    this.offered = offered;
    const availabilityKey = `focus:${this.revision}:${values.mapId}:${offered.join(",")}`;
    return offered.map(focus => ({ id: `focus_${focus}`, description: `${notes(focus)} ${descriptions[focus]} Select this persistent purpose only; no controller input or destination is executed. ${this.selections.get(focus) ? `Selected ${this.selections.get(focus)} time(s) without new tracked evidence; reconsider whether it is useful.` : ""}`.slice(0, 500),
      buttons: [], frames: 1, stop: false, execution: "profile", availabilityKey }));
  }
  select(id: string): GameActionExecution {
    const chosen = id.slice(6) as PokemonFocus;
    if (!id.startsWith("focus_") || !this.offered.includes(chosen)) throw new Error("The selected Pokemon focus is no longer offered.");
    let selected = false;
    return { next: () => {
      if (!selected) {
        selected = true; this.focus = chosen; this.age = 0; this.stagnant = 0; this.gained = false; this.revision++; this.healBefore = this.health;
        this.selections.set(chosen, Math.min(999, (this.selections.get(chosen) ?? 0) + 1));
      }
      return { done: true, reason: `Jev selected persistent focus: ${chosen}. No controller input was sent.` };
    } };
  }
  review(): GameActionExecution {
    let reviewed = false;
    return { next: () => {
      if (!reviewed) { reviewed = true; this.reconsider("Jev explicitly requested a new purpose decision."); }
      return { done: true, reason: "Jev requested focus reconsideration. No controller input was sent." };
    } };
  }
  complete(event: CompletedGameAction): void {
    if (!this.focus || event.record.interrupted || event.action.id.startsWith("focus_") || event.before?.values.phase === "battle") return;
    const map = event.before?.values.mapId;
    if (typeof map !== "number") return;
    const key = `${map}:${event.action.id}`;
    if (!this.attempts.has(key) && this.attempts.size === 64) this.attempts.delete(this.attempts.keys().next().value!);
    this.attempts.set(key, Math.min(999, (this.attempts.get(key) ?? 0) + 1));
    this.lastTarget = `${map}:${event.action.id}${event.record.executionReason ? ` (${event.record.executionReason})` : ""}`.slice(0, 256);
    this.age++; this.stagnant = this.gained ? 0 : this.stagnant + 1; this.gained = false;
    if (this.stagnant >= 6) this.reconsider("Six completed actions did not beat the best observed route distance or change tracked durable evidence. Choose a different useful purpose or stop; repeated map crossings/menu toggles are not new progress.");
    else if (this.age >= 32) this.reconsider("The purpose reached its 32-action review interval. Reassess current evidence and constraints before continuing.");
  }
  private reconsider(reason: string): void { this.focus = undefined; this.reason = reason; this.revision++; }
  attemptFact(map: number, id: string): string | undefined {
    const count = this.attempts.get(`${map}:${id}`) ?? 0;
    return count >= 2 ? `Already completed ${count} time(s) in this evidence episode. Repeated arrivals, menu changes or returning to an earlier distance do not establish new progress. Try another useful action or explain why this repetition serves the current focus.` : undefined;
  }
  facts(): readonly string[] {
    return [this.focus ? `Jev's persistent current focus: ${this.focus}. ${descriptions[this.focus]} A map change or incidental battle does not select a new purpose.` : `A purpose decision is required. ${this.reason}`,
      `Focus outcomes: ${this.stagnant} completed action(s) without a new best route distance; ${this.age}/32 since selection. Tracked durable evidence is separate from movement and map arrival. ${this.lastTarget ? `Last completed selection: ${this.lastTarget}.` : ""}`.slice(0, 500)];
  }
}

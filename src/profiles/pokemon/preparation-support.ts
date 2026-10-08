import type { StateValue } from "../../core/agent.js";
import type { GameReaderMemory, GameStateData } from "../../core/game-reader.js";
import type { GenerationOneLayout } from "./generation-one.js";
import type { PokemonItemCatalog } from "./item-catalog.js";
import type { PokemonItemLayout } from "./item-layout.js";
import type { PokemonFocus } from "./focus.js";
import { PokemonMoveCatalog } from "./move-catalog.js";
import { PokemonPreparationCatalog, type PokemonTrainerMon } from "./preparation-catalog.js";
import { pokemonTypeNames } from "./types.js";
import { pokemonLocation } from "./locations.js";

interface PartyMon {
  readonly id: number; readonly slot: number; readonly level: number; readonly hp: number; readonly maxHP: number;
  readonly status: number; readonly types: readonly number[]; readonly attacks: readonly number[];
  readonly ppKnown: boolean; readonly ppFull: boolean; readonly lowPP: boolean; readonly damaging: boolean;
}
const challenges: Readonly<Record<string, readonly [string, number, string, number?]>> = {
  brock: ["Brock", 34, "Boulder"], misty_and_bill: ["Misty", 35, "Cascade"],
  cut_and_surge: ["Lt. Surge", 36, "Thunder"], scope_and_erika: ["Erika", 37, "Rainbow"],
  safari_and_koga: ["Koga", 38, "Soul"], silph_and_sabrina: ["Sabrina", 40, "Marsh"],
  blaine: ["Blaine", 39, "Volcano"], eight_badges: ["Giovanni", 29, "Earth", 3],
};
const league: Readonly<Record<number, readonly [string, number]>> = { 245: ["Lorelei", 44], 246: ["Bruno", 33], 247: ["Agatha", 46], 113: ["Lance", 47] };
const typesText = (types: readonly number[]) => types.map(type => pokemonTypeNames[type] ?? "unknown").join("/");

/** Profile-local preparation evidence and purpose descriptions. It never chooses or executes a task. */
export class PokemonPreparationSupport {
  private party: readonly PartyMon[] = [];
  private notes: Partial<Record<PokemonFocus, string>> = {};
  private wasBattling = false;
  private pendingBattleCheck = false;
  postBattleReview = 0;
  healthKey = "unknown";
  restored: boolean | undefined;
  needsHealing: boolean | undefined;
  needsBalls = false;
  canStoreCapture = false;
  canBuyBalls = false;
  needsMedicineSupplies = false;
  constructor(private readonly layout: GenerationOneLayout, readonly catalog: PokemonPreparationCatalog,
    private readonly moves: PokemonMoveCatalog, private readonly items: PokemonItemLayout) {}
  reset(): void {
    this.catalog.reset(); this.moves.reset(); this.party = []; this.notes = {}; this.healthKey = "unknown";
    this.restored = undefined; this.needsHealing = undefined; this.needsBalls = false; this.canStoreCapture = false; this.canBuyBalls = false;
    this.wasBattling = false; this.pendingBattleCheck = false; this.postBattleReview = 0; this.needsMedicineSupplies = false;
  }
  note(focus: PokemonFocus): string { return this.notes[focus] ?? ""; }
  private bagQuantity(ram: Uint8Array, id: number): number | undefined {
    const count = ram[this.layout.bagCount - 0xc000]!;
    if (count > 20) return undefined;
    let quantity = 0;
    const seen = new Set<number>();
    for (let slot = 0; slot < count; slot++) {
      const item = ram[this.layout.bagItems - 0xc000 + slot * 2]!, amount = ram[this.layout.bagItems - 0xc000 + slot * 2 + 1]!;
      if (!item || item === 255 || !amount || amount > 99 || seen.has(item)) return undefined;
      seen.add(item); if (item === id) quantity = amount;
    }
    return quantity;
  }
  canCollect(ram: Uint8Array, id: number): boolean | undefined {
    const count = ram[this.layout.bagCount - 0xc000]!;
    if (count > 20) return undefined;
    let quantity: number | undefined;
    const seen = new Set<number>();
    for (let slot = 0; slot < count; slot++) {
      const item = ram[this.layout.bagItems - 0xc000 + slot * 2]!, amount = ram[this.layout.bagItems - 0xc000 + slot * 2 + 1]!;
      if (!item || item === 255 || !amount || amount > 99 || seen.has(item)) return undefined;
      seen.add(item); if (item === id) quantity = amount;
    }
    return quantity !== undefined ? quantity < 99 : count < 20;
  }
  encounterMaps(capture: boolean): readonly number[] {
    const maps = this.catalog.ordinaryEncounterMaps();
    if (!capture || !this.party.length) return maps;
    const useful = maps.filter(map => this.catalog.landEncounters(map)!.some(encounter => !this.party.some(mon => mon.id === encounter.species.id)));
    return useful.length ? useful : maps;
  }
  read(memory: GameReaderMemory, ram: Uint8Array, state: Readonly<Record<string, StateValue>>, items?: PokemonItemCatalog, captureAvailable = false): GameStateData {
    const values: Record<string, StateValue> = {}, descriptions: Record<string, string> = {}, facts: string[] = [], actionFacts: Record<string, string[]> = {};
    this.notes = {}; this.party = []; this.healthKey = "unknown"; this.restored = undefined; this.needsHealing = undefined;
    this.needsBalls = false; this.canStoreCapture = false; this.canBuyBalls = false; this.needsMedicineSupplies = false;
    const battling = state.battleKind === "wild" || state.battleKind === "trainer" || state.phase === "battle";
    if (this.wasBattling && !battling) this.pendingBattleCheck = true;
    this.wasBattling = battling;
    if (state.gameStarted !== true || !Number.isInteger(state.partyCount) || Number(state.partyCount) < 1 || Number(state.partyCount) > 6) return { values, descriptions };
    this.catalog.load(memory); this.moves.load(memory);
    const members: PartyMon[] = [], count = Number(state.partyCount);
    for (let slot = 1; slot <= count; slot++) {
      const start = this.layout.partyMons - 0xc000 + (slot - 1) * 44, mon = ram.subarray(start, start + 44);
      const hp = mon[1]! * 256 + mon[2]!, maxHP = mon[34]! * 256 + mon[35]!, level = mon[33]!, id = mon[0]!;
      if (mon.length !== 44 || id < 1 || id > 190 || maxHP < 1 || hp > maxHP || level < 1 || level > 100 || mon[4]! > 127) continue;
      const summaries: string[] = [], attacks: number[] = [];
      let ppKnown = true, ppFull = true, lowPP = false, moveCount = 0, damaging = false;
      for (let index = 0; index < 4; index++) {
        const moveID = mon[8 + index]!; if (!moveID) continue;
        moveCount++;
        const packed = mon[29 + index]!, pp = packed & 63, move = this.moves.move(moveID), maximum = move && this.moves.maxPP(move, packed);
        if (!move || maximum === undefined || pp > maximum) { ppKnown = false; ppFull = false; }
        else {
          if (pp < maximum) ppFull = false;
          if (this.moves.standard(move)) { damaging = true; if (pp > 0 && hp > 0) attacks.push(move.type); if (pp <= maximum / 4) lowPP = true; }
        }
        summaries.push(`slot${index + 1}: ${move?.name.slice(0, 12) ?? `id=${moveID}`}${move ? `,${pokemonTypeNames[move.type]},${this.moves.standard(move) ? `power=${move.power}` : "status/special"}` : ""},PP=${pp}/${maximum !== undefined && pp <= maximum ? maximum : "unknown"}`);
      }
      values[`party${slot}Moves`] = summaries.join("; ").slice(0, 256) || "none";
      descriptions[`party${slot}Moves`] = "ROM move names/types and base power for ordinary attacks, with live party PP/max PP including Gen I PP Ups. In battle use active battleMove fields; party data may await synchronization.";
      members.push({ id, slot, level, hp, maxHP, status: mon[4]!, types: [...new Set([mon[5]!, mon[6]!])], attacks,
        ppKnown: ppKnown && moveCount > 0, ppFull: ppFull && moveCount > 0, lowPP, damaging });
    }
    this.party = members;
    if (members.length !== count) facts.push("Some party data are invalid or transitional. Complete health, PP and type coverage remain unknown; do not infer that missing evidence means a healthy team.");
    else {
      const endangered = members.some(mon => mon.hp * 2 <= mon.maxHP), critical = members.some(mon => mon.hp < mon.maxHP * 0.3), statuses = members.some(mon => mon.status > 0);
      const ppRisk = members.some(mon => mon.ppKnown && mon.damaging && (mon.lowPP || mon.hp > 0 && !mon.attacks.length));
      this.needsHealing = endangered || statuses || ppRisk;
      this.restored = members.every(mon => mon.hp === mon.maxHP && mon.status === 0 && mon.ppKnown && mon.ppFull);
      this.healthKey = `${critical ? "critical" : endangered ? "low" : "adequate"}:${statuses}:${ppRisk}`;
      if (!battling && state.phase === "overworld" && state.movementInProgress !== true && state.controlBusy !== true && this.pendingBattleCheck) {
        this.pendingBattleCheck = false;
        if (this.needsHealing) this.postBattleReview = Math.min(Number.MAX_SAFE_INTEGER, this.postBattleReview + 1);
      }
      const health = members.map(mon => `slot${mon.slot} HP=${mon.hp}/${mon.maxHP} (${Math.round(mon.hp * 100 / mon.maxHP)}%)${mon.hp === 0 ? ",fainted" : mon.status ? ",status condition" : ""}${mon.lowPP ? ",low attack PP" : ""}`).join("; ");
      facts.push(`Party health: ${health}. ${this.needsHealing ? "Healing is recommended before optional battles or onward travel: a Center nurse restores HP, status and PP without a purchase. Choose and perform the service; arrival alone is insufficient." : "No decoded urgent healing need. Missing HP or PP can still make resting useful."}`.slice(0, 500));
      if (endangered) facts.unshift(`Priority: ${battling ? "After this battle, heal" : "Heal now"}: ${health}. A member has 50% HP or less. Choose healing before onward travel, training or another optional fight. Use a Center nurse; opening START does not restore HP. A battle still requires its current legal choices.`.slice(0, 500));
      this.notes.heal = `${this.needsHealing ? "Priority: heal before continuing" : "Optional healing"}: ${health}. Reach a Center and interact with its nurse; START is not healing.`.slice(0, 280);
      if (state.phase === "overworld") {
        values.partyHealth = health.slice(0, 256); descriptions.partyHealth = "Per-member current/max HP and percentage; 50% HP or less, status and low ordinary attack PP prioritize healing. Priorities are advice, not action restrictions.";
      }
    }
    let challengeName: string | undefined, team: readonly PokemonTrainerMon[] | undefined;
    let usefulTypes = "";
    const challenge = challenges[String(state.activeMilestone ?? "")];
    if (challenge && !String(state.badges ?? "").split(",").map(value => value.trim()).includes(challenge[2])) {
      challengeName = challenge[0]; team = this.catalog.trainer(memory, challenge[1], challenge[3] ?? 1);
    } else if (state.activeMilestone === "champion") {
      const next = league[Number(state.objectiveMapId)];
      if (next) { challengeName = next[0]; team = this.catalog.trainer(memory, next[1]); }
    }
    if (challengeName) {
      const lineup = team?.map(mon => `${mon.species.name} Lv${mon.level} ${typesText(mon.species.types)}`).join("; ");
      const usable = members.filter(mon => mon.hp > 0).flatMap(mon => mon.attacks);
      const knownAttacks = members.length === count && members.every(mon => mon.ppKnown);
      if (team && knownAttacks) {
        usefulTypes = Object.keys(pokemonTypeNames).map(Number).filter(type => team!.some(enemy => {
          const factors = usable.map(attack => this.moves.effectiveness(attack, enemy.species.types));
          return factors.every(factor => factor !== undefined) && (!factors.length || Math.max(...factors as number[]) <= 1) &&
            (this.moves.effectiveness(type, enemy.species.types) ?? 0) > 1;
        })).map(type => pokemonTypeNames[type]).join("/");
        if (usefulTypes) facts.push(`Preparation coverage opportunity against ${challengeName}: ${usefulTypes} ordinary attacking types can improve a decoded neutral/resisted matchup. Seek Pokemon that actually learn useful moves; a species' own types alone do not establish attack coverage.`.slice(0, 500));
      }
      const matchups = team?.map(enemy => {
        const factors = usable.map(type => this.moves.effectiveness(type, enemy.species.types));
        const best = knownAttacks && factors.length && factors.every(value => value !== undefined) ? Math.max(...factors as number[]) : undefined;
        return `${enemy.species.name}: best usable ordinary attack factor=${best === undefined ? "unknown" : `${best}x`}`;
      }).join("; ");
      const level = team?.length ? Math.max(...team.map(mon => mon.level)) : undefined;
      facts.push(`Upcoming recognized challenge: ${challengeName}. ${lineup ?? "Cartridge team data unavailable"}. ${matchups ?? "Matchups unknown"}. Only type factors, not predicted damage or guaranteed victory.`.slice(0, 500));
      if (level !== undefined) {
        const strongest = members.length === count ? Math.max(...members.map(mon => mon.level)) : undefined;
        this.notes.train = `The ${challengeName} team reaches Lv${level}; your highest known level is ${strongest ?? "unknown"}. ${strongest !== undefined && strongest < level ? "Training is recommended before challenging it." : "Levels alone do not establish readiness; inspect moves, health and matchups."}`;
        facts.push(this.notes.train);
      }
      if (state.phase === "overworld") { values.upcomingChallenge = `${challengeName}: ${lineup ?? "unknown team"}`.slice(0, 256); descriptions.upcomingChallenge = "Exact ROM-derived team for an uncompleted leader in the active recognized user milestone. No inferred challenge for custom objectives; no learned enemy moves or victory guarantee."; }
    }
    const balls = Number(state.pokeBalls), money = Number(state.money), price = items?.price(4), boxCount = ram[this.items.boxCount - 0xc000]!;
    this.needsBalls = state.pokeBalls === 0;
    this.canStoreCapture = count < 6 || boxCount < 20;
    this.canBuyBalls = price !== undefined && Number.isFinite(money) && money >= price &&
      (Number(state.bagCount) < 20 || Array.from({ length: Math.min(Number(state.bagCount) || 0, 20) }, (_, slot) => ram[this.layout.bagItems - 0xc000 + slot * 2] === 4 && ram[this.layout.bagItems - 0xc000 + slot * 2 + 1]! < 99).some(Boolean));
    const supplies = this.needsBalls ? `No capture balls. ${price ? `A Poke Ball costs ${price}; money=${Number.isFinite(money) ? money : "unknown"}, affordable quantity up to ${Number.isFinite(money) ? Math.min(99, Math.floor(money / price)) : "unknown"}.` : "Ball price/affordability unknown."} Buy supplies at a Mart before seeking ordinary captures.` : `${Number.isFinite(balls) ? balls : "Unknown"} capture ball(s); throwing a ball is a separate battle choice.`;
    const potions = [0x10, 0x11, 0x12, 0x13, 0x14].map(id => this.bagQuantity(ram, id));
    const hpStock = potions.every(quantity => quantity !== undefined) ? potions.reduce<number>((sum, amount) => sum + amount!, 0) : undefined;
    const antidotes = this.bagQuantity(ram, 0x0b);
    this.needsMedicineSupplies = (hpStock !== undefined && hpStock < 2 || antidotes !== undefined && antidotes < 2) &&
      [0x14, 0x0b].some(id => items?.price(id) !== undefined && Number.isFinite(money) && money >= items.price(id)! &&
        (Number(state.bagCount) < 20 || (this.bagQuantity(ram, id) ?? 99) < 99));
    const medicineSupplies = `Medicine reserve: ${hpStock ?? "unknown"} HP-restoring items, ${antidotes ?? "unknown"} Antidotes. Consider a small reserve of two each when affordable/storable. Potions restore HP; Antidotes cure poison. Preserve funds for required balls; buying medicine does not heal until a selected item is applied to a selected party slot.`;
    this.notes.shop = `${this.needsMedicineSupplies ? "Priority: consider missing medicine reserves. " : ""}${medicineSupplies} ${supplies}`.slice(0, 500);
    this.notes.catch = `Priority: attempt every eligible wild species absent from the current team. ${count < 2 ? "Only one party member: a useful backup is recommended." : "New types are useful, but are not required to attempt a new team species."} ${supplies}`.slice(0, 350);
    if (!battling && this.needsBalls && this.canBuyBalls && this.canStoreCapture) facts.unshift("Priority: capture supplies are missing. Before seeking more wild encounters, choose capture/shopping preparation and buy affordable balls. Then attempt every eligible wild species absent from the current party, including species already owned in the Pokedex. Each purchase and ball still requires a separate Jev choice.");
    if (!battling) facts.push(`Team preparation: ${count} member(s). ${this.notes.catch} Capture purpose can include buying balls first; neither entering grass nor selecting a ball verifies a capture.`.slice(0, 500));
    if (state.phase === "overworld") { values.preparationNeeds = `${this.needsHealing ? "heal recommended; " : ""}${count < 2 ? "backup recommended; " : ""}${this.needsBalls ? "capture supplies missing" : Number.isFinite(balls) && balls > 0 ? "capture supplies present" : "capture supplies unknown"}`; descriptions.preparationNeeds = "Advisory needs derived from current health, party size and inventory. Jev selects the purpose and each gameplay action; user constraints remain authoritative."; }
    const local = this.catalog.landEncounters(Number(state.mapId));
    if (local?.length) facts.push(`Local land encounters from this ROM: ${local.slice(0, 6).map(entry => `${entry.species.name} Lv${entry.minLevel}-${entry.maxLevel} ${typesText(entry.species.types)}`).join("; ")}. Availability also depends on encounter tiles, scripts, repel and movement; these are not observed enemies.`.slice(0, 500));
    if (captureAvailable && state.phase === "battle" && state.battleKind === "wild" && state.battleType === "normal") {
      const enemy = ram.subarray(this.layout.enemyMon - 0xc000, this.layout.enemyMon - 0xc000 + 29), species = this.catalog.speciesData(enemy[0]!);
      const hp = enemy[1]! * 256 + enemy[2]!, maxHP = enemy[15]! * 256 + enemy[16]!;
      if (species && enemy[14]! >= 1 && enemy[14]! <= 100 && hp > 0 && hp <= maxHP && members.length === count) {
        const teamTypes = members.flatMap(mon => mon.types), knownTypes = teamTypes.every(type => pokemonTypeNames[type]);
        const candidate = `Capture candidate: ${species.name}, Lv${enemy[14]}, HP=${hp}/${maxHP}; ${members.some(mon => mon.id === species.id) ? "species already in party" : "new party species"}; ${knownTypes ? `new team types=${typesText(species.types.filter(type => !teamTypes.includes(type))) || "none"}` : "team type coverage unknown"}. Avoid knocking out a desired capture: type factors do not predict remaining HP. A ball attempt is not success; inspect party/owned-Pokedex changes.`;
        facts.unshift(candidate);
        actionFacts.open_capture_bag = [candidate];
        for (let slot = 1; slot <= 4; slot++) actionFacts[`use_move_${slot}`] = ["If you want this wild Pokemon, inspect capture preparation and the selected move's HP/KO risk. Weaken once when cautious, then reassess; stop damaging at the ball's HP plateau or when another hit risks a KO. Base power/type factors alone do not predict exact damage."];
      }
    }
    this.notes.progress = `${this.needsHealing ? "Lower priority: heal before proceeding. " : ""}${this.needsBalls ? "Buy missing capture balls before more encounters. " : ""}Collect nearby verified items and attempt new team species before routine story travel. Respect supplied constraints.`;
    return { values, descriptions, decisionSupport: { facts, actionFacts } };
  }
  destinationFact(maps: readonly number[]): string {
    return `Known candidate encounter areas: ${maps.slice(0, 4).map(map => `${pokemonLocation(map)}: ${this.catalog.landEncounters(map)?.slice(0, 2).map(entry => `${entry.species.name} Lv${entry.minLevel}-${entry.maxLevel} ${typesText(entry.species.types)}`).join("/") ?? "unknown"}`).join("; ")}. Species types do not prove learned attacks; Jev chooses each target.`.slice(0, 330);
  }
}

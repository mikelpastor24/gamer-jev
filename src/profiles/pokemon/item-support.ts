import { createHash } from "node:crypto";
import type { AgentAction, GameState, StateValue } from "../../core/agent.js";
import type { GameReaderMemory, GameStateData } from "../../core/game-reader.js";
import type { GenerationOneLayout } from "./generation-one.js";
import type { PokemonBattleLayout } from "./battle-layout.js";
import type { PokemonItemLayout } from "./item-layout.js";
import { PokemonItemCatalog } from "./item-catalog.js";
import type { PokemonItemExecutionState, PokemonItemTarget } from "./item-execution.js";
import { decodeName } from "./encoding.js";
import { pokemonTypeNames } from "./types.js";
import { PokemonMoveCatalog } from "./move-catalog.js";
import { PokemonCaptureSupport } from "./capture-support.js";
import { medicineBenefit, pokemonMedicine, pokemonPartyMembers } from "./medicine.js";

interface Item { readonly id: number; readonly quantity: number }
interface Snapshot extends PokemonItemExecutionState {
  readonly stateKey: string;
  readonly canConfirm: boolean;
  readonly choices: readonly { readonly target: PokemonItemTarget; readonly id: string; readonly description: string }[];
}
const ball = (id: number) => id >= 1 && id <= 4;
const stateKey = (values: Readonly<Record<string, StateValue>>) => JSON.stringify([
  values.phase, values.mapId, values.battleKind, values.battleType, values.battlePlayer, values.battleEnemy,
  values.battlePlayerMoves, values.bagItems, values.money, values.partyCount,
  values.screenTextTop, values.screenTextBottom, values.menuCursorX, values.menuCursorY,
]);

/** Inventory and capture evidence. Offers choices; never selects a shopping or capture goal. */
export class PokemonItemSupport {
  readonly catalog: PokemonItemCatalog;
  captureAvailable = false;
  private snapshot: Snapshot | undefined;
  private readonly captures: PokemonCaptureSupport;
  constructor(private readonly layout: PokemonItemLayout, private readonly mon: GenerationOneLayout,
    private readonly battle: PokemonBattleLayout, private readonly moves = new PokemonMoveCatalog(battle)) {
    this.catalog = new PokemonItemCatalog(layout);
    this.captures = new PokemonCaptureSupport(battle, mon, moves);
    for (const [name, address] of Object.entries(layout)) if (!Number.isSafeInteger(address) ||
      (["names", "prices"].includes(name) ? address < 0 || address >= 8 * 1024 * 1024 : address < 0xc000 || address > 0xdfff)) {
      throw new Error("Invalid Generation I item layout.");
    }
  }
  reset(): void { this.catalog.reset(); this.moves.reset(); this.snapshot = undefined; this.captureAvailable = false; }
  executionState(): PokemonItemExecutionState | undefined { return this.snapshot; }
  contextKey(state: GameState): string | undefined { return this.snapshot?.stateKey === stateKey(state.values) ? this.snapshot.context : undefined; }
  target(id: string): PokemonItemTarget | undefined { return this.snapshot?.choices.find(choice => choice.id === id)?.target; }
  pending(state: GameStateData): boolean { return this.snapshot?.stateKey === stateKey(state.values) && this.snapshot.menu === "pending"; }
  list(state: GameState): boolean { return this.contextKey(state) !== undefined && ["bag", "shop", "quantity", "pending", "use"].includes(this.snapshot!.menu); }
  quantity(state: GameState): boolean { return this.contextKey(state) !== undefined && this.snapshot!.menu === "quantity"; }

  read(memory: GameReaderMemory, ram: Uint8Array, state: Readonly<Record<string, StateValue>>): GameStateData {
    this.snapshot = undefined;
    this.captureAvailable = false;
    let decisionGoal: string | undefined;
    const values: Record<string, StateValue> = {}, descriptions: Record<string, string> = {};
    const facts: string[] = [], actionFacts: Record<string, string[]> = {};
    const finish = (): GameStateData => ({ values, descriptions, decisionSupport: { facts, actionFacts, ...(decisionGoal ? { decisionGoal } : {}) } });
    if (state.gameStarted !== true) return finish();
    this.catalog.load(memory);
    const u8 = (address: number) => ram[address - 0xc000]!;
    const u16 = (address: number) => u8(address) | u8(address + 1) << 8;
    const count = u8(this.mon.bagCount);
    const items: Item[] = count <= 20 ? Array.from({ length: count }, (_, slot) => ({
      id: u8(this.mon.bagItems + slot * 2), quantity: u8(this.mon.bagItems + slot * 2 + 1),
    })) : [];
    const validBag = count <= 20 && items.every(item => item.id > 0 && item.id < 255 && item.quantity > 0 && item.quantity <= 99) &&
      new Set(items.map(item => item.id)).size === count;
    const balls = validBag ? items.filter(item => ball(item.id)).reduce((sum, item) => sum + item.quantity, 0) : undefined;
    values.pokeBalls = balls ?? "unknown";
    descriptions.pokeBalls = "Total usable ordinary capture balls (Master, Ultra, Great, Poke); excludes Safari balls. Malformed inventory remains unknown.";
    if (validBag) for (let offset = 0; offset < items.length; offset += 5) facts.push(`Inventory: ${items.slice(offset, offset + 5).map((item, i) =>
      `slot${offset + i + 1} ${this.catalog.name(item.id) ?? `itemId=${item.id}`} x${item.quantity}`).join("; ")}.`);
    if (balls === 0) facts.push("No usable Poke Balls are in the bag. Capturing is currently impossible; after story prerequisites, a Poke Mart can sell supplies if money and bag space permit. Trainer battles do not give capture balls.");
    else if (balls !== undefined) facts.push(`Capture supplies: ${balls} ordinary ball(s). A successful capture may expand the team; buying, training, healing, or continuing are separate choices for Jev.`);
    if (count === 20) facts.push("The bag has all 20 slots occupied. A new item type needs space; an existing stack can accept only up to 99. Visible loot can be useful but may fail when the bag is full.");
    const partyCount = u8(this.mon.partyCount), boxCount = u8(this.layout.boxCount);
    if (partyCount >= 1 && partyCount <= 6) {
      facts.push(`Party preparation: ${partyCount}/6 member(s). ${partyCount === 1 ? "There is only one party member; consider useful wild captures for coverage and backup." : "Party size alone does not establish battle readiness."} Check HP, levels, move PP and type matchups before gym battles. Captured Pokemon may need healing and training.`);
      if (partyCount === 6) facts.push(boxCount <= 20 ? `Party full; current PC box ${boxCount}/20. ${boxCount === 20 ? "Capture is blocked until storage space is made." : "A capture goes to the current box and will not immediately join the active team."}` : "Party full; current box capacity is unknown, so capture eligibility is unverified.");
    }
    if (state.phase === "naming" || state.phase === "transition") return finish();
    const normalBattle = state.phase === "battle" && state.battleType === "normal";
    const members = pokemonPartyMembers(ram, this.mon, this.battle, normalBattle);
    const hpStock = validBag ? items.filter(item => pokemonMedicine(item.id)?.hp).reduce((sum, item) => sum + item.quantity, 0) : undefined;
    const antidotes = validBag ? items.find(item => item.id === 0x0b)?.quantity ?? 0 : undefined;
    const poisoned = members.some(member => member.hp > 0 && (member.status & 8) !== 0);
    const injured = members.some(member => member.hp > 0 && member.hp * 100 <= member.maxHP * 50);
    const medicineNeeded = validBag && members.some(member => (normalBattle ?
      member.slot === u8(this.battle.playerPartyIndex) && (member.hp * 100 <= member.maxHP * 30 || member.status !== 0) :
      member.hp * 100 <= member.maxHP * 50 || member.status !== 0) && items.some(item => this.catalog.name(item.id) && medicineBenefit(item.id, member)));
    const usableMedicine = validBag && members.some(member => items.some(item => this.catalog.name(item.id) && medicineBenefit(item.id, member)));
    facts.push(`Medicine supplies: ${hpStock ?? "unknown"} HP-restoring item(s), ${antidotes ?? "unknown"} Antidote(s). Potions restore HP but do not cure poison; Antidotes cure poison but do not restore HP. Neither restores PP or revives fainted Pokemon. Keep a small reserve (around two of each) when affordable; Centers offer broader recovery.`);
    if (medicineNeeded) facts.unshift("Priority: a known injured or status-affected member can benefit from a medicine in the bag. Choose open_medicine_bag, select a suitable item, then its party slot. Each step needs Jev's choice; inspect HP/status and inventory afterward. A Potion alone does not cure poison.");
    const player = ram.subarray(this.mon.battleMon - 0xc000, this.mon.battleMon - 0xc000 + 29);
    const enemy = ram.subarray(this.mon.enemyMon - 0xc000, this.mon.enemyMon - 0xc000 + 29);
    const alive = (data: Uint8Array) => data[0]! > 0 && data[0]! <= 190 && data[14]! >= 1 && data[14]! <= 100 &&
      data[1]! * 256 + data[2]! > 0 && data[1]! * 256 + data[2]! <= data[15]! * 256 + data[16]!;
    const tower = Number(state.mapId) >= 0x90 && Number(state.mapId) <= 0x94;
    // The scripted Marowak in Tower 6F is not capturable, even after obtaining the Scope.
    const ghost = tower && (!items.some(item => item.id === 0x48) || state.mapId === 0x93 && u8(this.layout.enemySpecies) === 0x91);
    const eligibleTarget = normalBattle && state.battleKind === "wild" && alive(player) && alive(enemy) &&
      u8(this.layout.enemySpecies) === enemy[0] && partyCount >= 1 && partyCount <= 6 &&
      (partyCount < 6 || boxCount < 20) && !ghost;
    const capture = eligibleTarget && validBag && balls! > 0;
    this.captureAvailable = Boolean(capture);
    const teamSpecies: number[] = [];
    let speciesKnown = partyCount >= 1 && partyCount <= 6;
    if (speciesKnown) for (let slot = 0; slot < partyCount; slot++) {
      const address = this.mon.partyMons + slot * 44, id = u8(address), hp = u8(address + 1) * 256 + u8(address + 2),
        maximum = u8(address + 34) * 256 + u8(address + 35), level = u8(address + 33);
      if (id > 0 && id <= 190 && maximum > 0 && hp <= maximum && level >= 1 && level <= 100) teamSpecies.push(id);
      else speciesKnown = false;
    }
    const newTeamTarget = eligibleTarget && speciesKnown && !teamSpecies.includes(u8(this.layout.enemySpecies));
    const capturePriority = capture && newTeamTarget;
    this.moves.load(memory);
    const capturePlan = capture ? this.captures.read(ram, player, enemy, items.filter(item => ball(item.id)).map(item => item.id), u8(this.layout.catchRate)) : undefined;
    if (capturePlan) {
      facts.push(...capturePlan.facts.map(fact => capturePriority ? fact : fact.replace(/^Priority: /, "Capture advice: ")));
      for (const [id, notes] of Object.entries(capturePlan.moveFacts)) actionFacts[id] = notes.map(note => capturePriority ? note : note.replace(/^Priority: /, ""));
    }
    if (newTeamTarget) {
      facts.unshift(capturePriority ?
        `Priority: attempt to capture this eligible wild species: it is absent from the current team. Pokedex ownership and shared types do not remove this priority. ${capturePlan!.weaken ? "First weaken with one cautious attack, then reassess HP before opening the bag." : "Select open_capture_bag, then a ball; further weakening is not required now."} Avoid knocking it out. A ball attempt is not success. Healing remains a post-battle priority.` :
        "Priority: this eligible wild species is absent from the current team, but no usable capture balls are verified. Do not pretend it can be captured now. Buy balls at a Mart before more encounters when affordable and storable; this battle still requires Jev's legal choices.");
    } else if (eligibleTarget && speciesKnown) facts.push("The wild species is already in the current team. Another capture remains a legal choice, but is not prioritized as a new team species.");
    if (normalBattle && state.battleKind === "wild" && alive(enemy)) {
      if (capture) facts.push(`Wild capture evidence: HP ${enemy[1]! * 256 + enemy[2]!}/${enemy[15]! * 256 + enemy[16]!}; status byte ${enemy[4]}; catch-rate threshold ${u8(this.layout.catchRate)}/255 (not a success percentage). Lower HP and supported status conditions improve ordinary captures. Defeating the enemy prevents capturing it; choose attacks that will not knock it out if you want to catch it.`);
      const teamTypes = new Set<number>();
      let teamKnown = partyCount >= 1 && partyCount <= 6;
      if (partyCount <= 6) for (let slot = 0; slot < partyCount; slot++) {
        const address = this.mon.partyMons + slot * 44;
        if (u8(address) > 0 && u8(address) <= 190 && u8(address + 33) >= 1 && u8(address + 33) <= 100 &&
          u8(address + 34) * 256 + u8(address + 35) > 0 && pokemonTypeNames[u8(address + 5)] && pokemonTypeNames[u8(address + 6)]) {
          teamTypes.add(u8(address + 5)); teamTypes.add(u8(address + 6));
        } else teamKnown = false;
      }
      const newTypes = teamKnown ? [...new Set([enemy[5]!, enemy[6]!])].filter(type => pokemonTypeNames[type] && !teamTypes.has(type)) : [];
      if (newTypes.length) facts.push(`This enemy adds type coverage absent from the current party: ${newTypes.map(type => pokemonTypeNames[type]).join("/")}. Type coverage alone does not prove that it can defeat the next gym.`);
      if (ghost) facts.push("This Pokemon Tower encounter has unverified ghost eligibility or is the scripted Marowak; ordinary capture actions are unavailable.");
    }
    let menu: PokemonItemExecutionState["menu"] = normalBattle && state.battleMenu === "moves_pending" ? "pending" : normalBattle && state.battleMenu === "moves" ? "moves" :
      normalBattle && state.battleMenu === "command" ? "command" : "other";
    const pointer = u16(this.layout.listPointer), listId = u8(this.layout.listId), listCount = u8(this.layout.listCount);
    const bagList = validBag && (normalBattle || state.phase === "menu" || state.phase === "text") && pointer === this.mon.bagCount && listId === 3 && listCount === count && u8(this.layout.printPrices) === 0;
    const shopContext = !normalBattle && ["menu", "text"].includes(String(state.phase)) && pointer === this.layout.itemList && listId === 2 &&
      listCount === u8(this.layout.itemList) && listCount >= 1 && listCount <= 14 && u8(this.layout.printPrices) === 1;
    const shopList = shopContext && state.phase === "menu";
    const tiles = ram.subarray(this.mon.tileMap - 0xc000, this.mon.tileMap - 0xc000 + 360);
    const row = (y: number, x: number, length: number) => decodeName(Uint8Array.from([...tiles.subarray(y * 20 + x, y * 20 + x + length), 0x50]));
    const quantityOverlay = tiles[9 * 20 + 7] === 0x79 && tiles[9 * 20 + 19] === 0x7b;
    const listVariables = u8(this.battle.menuY) === 4 && u8(this.battle.menuX) === 5 &&
      u8(this.battle.menuMax) === (listCount < 2 ? 1 : 2) && (u8(this.battle.watchedKeys) & 7) === 7 && u8(this.battle.swappingMove) === 0;
    const scroll = u8(this.layout.scroll), cursor = u8(this.battle.menuItem), selected = scroll + cursor;
    const savedBagSlot = scroll + u8(this.layout.bagSaved), savedItem = items[savedBagSlot];
    const useMenu = !normalBattle && validBag && pointer === this.mon.bagCount && listId === 3 && savedItem &&
      pokemonMedicine(savedItem.id) && u8(this.layout.whichPokemon - 1) === savedItem.id &&
      row(11, 15, 3) === "USE" && row(13, 15, 4) === "TOSS" && u8(this.battle.menuY) === 11 &&
      u8(this.battle.menuX) === 14 && u8(this.battle.menuMax) === 1 && (u8(this.battle.watchedKeys) & 3) === 3 && cursor <= 1 && tiles[(11 + cursor * 2) * 20 + 14] === 0xed;
    const itemRow = state.menuKind === "overworld" ? Array.from({ length: 18 }, (_, y) => y).find(y =>
      row(y, 0, 20)?.replace(/^>\s*/, "").trim() === "ITEM") : undefined;
    if (state.phase === "overworld") menu = "overworld";
    else if (itemRow !== undefined && typeof state.menuCursorY === "number") menu = "start";
    const listItems = shopContext ? Array.from({ length: listCount }, (_, slot) => u8(this.layout.itemList + slot + 1)) : items.map(item => item.id);
    const context = createHash("sha256").update(JSON.stringify([
      normalBattle ? "battle" : "field", state.mapId, state.battleKind, state.battleType, partyCount, boxCount, state.money, items, members,
      ...(normalBattle ? [...player, ...enemy, u8(this.layout.catchRate), u8(this.layout.enemySpecies)] : []),
      ...(shopContext ? listItems : []),
      capturePlan,
    ])).digest("hex").slice(0, 24);
    const visible = (bagList || shopList) && !quantityOverlay && listVariables && scroll <= listCount && Array.from({ length: Math.min(4, listCount - scroll + 1) }, (_, i) => {
      const name = scroll + i === listCount ? "CANCEL" : this.catalog.name(listItems[scroll + i]!);
      return name !== undefined && row(4 + i * 2, 6, 13) === name;
    }).every(Boolean);
    const ready = visible && cursor <= u8(this.battle.menuMax) && selected <= listCount && tiles[(4 + cursor * 2) * 20 + 5] === 0xed;
    if (ready) menu = bagList ? "bag" : "shop";
    else if (visible) menu = "pending";
    if (useMenu) menu = "use";
    const quantity = u8(this.layout.quantity);
    if (shopContext && quantityOverlay && quantity >= 1 && quantity <= 99 && tiles[10 * 20 + 8] === 0xf1 &&
      tiles[10 * 20 + 9] === 0xf6 + Math.floor(quantity / 10) && tiles[10 * 20 + 10] === 0xf6 + quantity % 10) {
      menu = "quantity";
      facts.push("Mart quantity prompt: " + quantity + " selected. UP increases the quantity; DOWN decreases it, wrapping between 1 and 99. A accepts this quantity and opens a price confirmation; it does not yet purchase. B cancels. Check total price and bag capacity before confirming YES.");
      actionFacts.press_a = ["A accepts quantity " + quantity + "; Jev must separately confirm the total price."];
      actionFacts.press_up = ["Increase quantity " + quantity + " by one (99 wraps to 1)."];
      actionFacts.press_down = ["Decrease quantity " + quantity + " by one (1 wraps to 99)."];
      const chosenItem = u8(this.layout.whichPokemon - 1), medicine = pokemonMedicine(chosenItem);
      if (medicine) {
        const stock = chosenItem === 0x0b ? antidotes : hpStock;
        facts.push(`Medicine quantity plan: ${this.catalog.name(chosenItem) ?? chosenItem}; related stock ${stock ?? "unknown"}. A small reserve of two suggests ${stock === undefined ? "an unknown amount" : Math.max(0, 2 - stock)} additional item(s), subject to price/capacity and supplied constraints. Current quantity ${quantity}; do not buy 99 by wrapping DOWN without a plan.`);
      }
    }
    const choices: Snapshot["choices"][number][] = [];
    const canConfirm = menu !== "bag" || selected === count || !ball(items[selected]!.id) || capture;
    if (capturePriority && ["command", "moves"].includes(menu)) {
      const warning = `Capture this species absent from the team; Pokedex ownership and shared types do not remove this priority. ${capturePlan!.reason}`;
      for (const id of ["press_a", "use_move_1", "use_move_2", "use_move_3", "use_move_4"]) actionFacts[id] = [...(actionFacts[id] ?? []), warning];
      if (menu === "moves") actionFacts.press_a!.unshift(...(capturePlan!.moveFacts[`use_move_${Number(state.battleMoveSelection)}`] ?? []));
    }
    if (capture && ["command", "moves"].includes(menu)) choices.push({ target: { kind: "bag" }, id: "open_capture_bag",
      description: `${capturePriority && !capturePlan!.weaken ? "Priority: capture this species absent from the team. " : capturePlan!.weaken ? "Capture preparation: a cautious weakening attack is recommended first. " : ""}Open ITEM in this wild battle to inspect capture balls. Do not throw anything yet; Jev chooses a ball in the next observation.` });
    if (usableMedicine && ["command", "moves", "overworld", "start"].includes(menu) &&
      state.movementInProgress !== true && state.controlBusy !== true) choices.push({ target: { kind: "medicine_bag" }, id: "open_medicine_bag",
      description: `${medicineNeeded ? "Priority: treat a known injured or status-affected party member. " : ""}Open the player bag to inspect medicines ${normalBattle ? "in battle" : "through START and ITEM"}. Stop at the bag; Jev must separately select the item and the party slot. Do not use any medicine automatically.` });
    if (menu === "bag" && capture) items.forEach((item, slot) => {
      if (ball(item.id)) choices.push({ target: { kind: "ball", slot }, id: `throw_ball_slot_${slot + 1}`,
        description: `${capturePriority && !capturePlan!.weaken ? "Priority: attempt this new team species. " : capturePlan!.weaken ? "A cautious weakening attack is recommended first; B leaves the bag. " : ""}Throw one ${this.catalog.name(item.id) ?? `ballId=${item.id}`} from bag slot ${slot + 1} (${item.quantity} left). ${capturePlan!.ballFacts[item.id]} Navigate to exactly this slot and confirm once.`.slice(0, 500) });
    });
    if (menu === "bag" && validBag) items.forEach((item, slot) => {
      const effect = pokemonMedicine(item.id), name = this.catalog.name(item.id);
      const targets = members.filter(member => medicineBenefit(item.id, member));
      if (effect && name && targets.length) choices.push({ target: { kind: "medicine", slot }, id: `choose_medicine_slot_${slot + 1}`,
        description: `Select ${name} from bag slot ${slot + 1} (${item.quantity} left). ${effect.hp ? `Restores up to ${effect.hp === 999 ? "maximum" : effect.hp} HP` : "No HP restoration"}; ${effect.status === 8 ? "cures poison" : effect.status ? "cures status" : "does not cure status"}. Can benefit party slot(s) ${targets.map(member => member.slot + 1).join(", ")}. Stop at the next menu; Jev separately chooses USE if shown and then the exact party member. Never choose a target automatically.` });
    });
    if (menu === "shop") {
      facts.push("Verified Mart BUY list. Choosing an item opens the quantity prompt; Jev must separately choose quantity and confirm the total price. UP increases quantity, DOWN decreases it, A proceeds, B cancels. A later YES confirms the purchase. Selling is a different menu.");
      listItems.forEach((id, slot) => {
        const price = this.catalog.price(id), name = this.catalog.name(id), existing = items.find(item => item.id === id);
        const capacity = validBag ? existing ? 99 - existing.quantity : count < 20 ? 99 : 0 : undefined;
        const affordable = price !== undefined && typeof state.money === "number" ? Math.floor(state.money / price) : undefined;
        const limit = capacity !== undefined && affordable !== undefined ? Math.min(capacity, affordable, 99) : undefined;
        facts.push(`Shop slot${slot + 1}: ${name ?? `itemId=${id}`}; unit price ${price ?? "unknown"}; currently affordable/storable quantity ${limit ?? "unknown"}.`);
        const medicine = pokemonMedicine(id), stock = id === 0x0b ? antidotes : hpStock;
        const medicinePriority = medicine && stock !== undefined && stock < 2;
        if (medicine) facts.push(`Medicine purchase ${name ?? id}: ${id === 0x0b ? "cures poison, not HP" : "restores HP; ordinary Potions do not cure poison"}; ${stock ?? "unknown"} related supply item(s) held, reserve suggestion 2; ${id === 0x0b && poisoned ? "a living member is poisoned" : medicine.hp && injured ? "a living member has 50% HP or less" : "reserve for later needs"}. Buy only what is affordable/storable; preserve money for needed balls.`);
        if (name && limit !== undefined && limit > 0) choices.push({ target: { kind: "shop", slot }, id: `choose_shop_item_slot_${slot + 1}`,
          description: `${medicinePriority ? `Priority: obtain ${id === 0x0b ? "Antidotes for poison" : "HP medicine for injuries"}; related stock ${stock}, small reserve target 2. ` : balls === 0 && ball(id) ? "Priority: buy missing capture balls for species absent from the team. " : ""}Select ${name} at Mart slot ${slot + 1}, unit price ${price}; at most ${limit} currently affordable/storable. Open its quantity prompt with one confirmation; do not automatically buy or choose a quantity.` });
      });
    }
    if (menu === "bag") {
      facts.push("The player bag is open. throw_ball_slot_N throws exactly one selected ball in eligible battles; choose_medicine_slot_N opens the chosen medicine's next menu. Jev then selects its party target. B cancels; SELECT reordering is excluded in this verified list.");
      actionFacts.press_a = [selected === count ? "A selects CANCEL, returning to battle commands." : `A uses bag slot ${selected + 1}: ${this.catalog.name(items[selected]!.id) ?? `itemId=${items[selected]!.id}`} x${items[selected]!.quantity}.`];
      if (capturePlan && selected < count && ball(items[selected]!.id)) actionFacts.press_a.push(capturePlan.ballFacts[items[selected]!.id]!);
      if (capturePlan?.weaken) {
        actionFacts.press_b = ["Priority: return to battle commands to choose one cautious weakening attack, then reassess HP. B does not throw or select a move."];
        actionFacts.press_a.push("A throws the highlighted ball at current HP; a cautious weakening attack is recommended first.");
      }
    }
    if (menu === "use") {
      facts.push(`Selected medicine ${this.catalog.name(savedItem!.id)}: this is the overworld USE/TOSS menu. Choose USE to open party targeting; TOSS discards items and does not heal. No member has been treated yet.`);
      actionFacts.press_a = [`A selects ${cursor === 0 ? "USE" : "TOSS"} for ${this.catalog.name(savedItem!.id)}. ${cursor === 0 ? "Choose the party slot separately next." : "This discards medicine, rather than treating a member."}`];
      decisionGoal = "Choose USE for the selected medicine, then choose a beneficial party slot in the next observation. TOSS does not heal; each selection remains a separate Jev choice.";
    }
    for (const choice of choices) actionFacts[choice.id] = [choice.description];
    if (["command", "moves"].includes(menu) && normalBattle && alive(player) && alive(enemy)) {
      decisionGoal = capturePriority ? `Capture this eligible wild species absent from the team. ${capturePlan!.reason} ${capturePlan!.weaken ? "Choose a cautious use_move action now; do not open the bag yet." : "Choose open_capture_bag, then select a ball."} Respect supplied constraints; reassess HP after every move or throw.` :
        !capture && state.battleKind === "wild" ? "Resolve this wild battle so the party can reach healing or supplies. Capture is currently unavailable; repeated weakening cannot make a missing ball or blocked capture possible. Choose a usable damaging move or an escape attempt. Status moves do no direct damage; do not repeat an exhausted effect. Buy balls after leaving this battle." : undefined;
    } else if (menu === "bag" && capturePriority) decisionGoal = capturePlan!.weaken ?
      `Prepare this wild capture before throwing: choose B to leave the bag, then choose one cautious weakening move in the next observation. ${capturePlan!.reason} Each step requires Jev's selection.` :
      `Attempt to capture this wild species absent from the team: select one available throw_ball_slot action. ${capturePlan!.reason} It throws exactly one chosen ball; success is not guaranteed. Respect supplied constraints.`;
    else if (menu === "shop" && choices.some(choice => choice.target.kind === "shop" &&
      (listItems[choice.target.slot] === 0x0b && poisoned && antidotes === 0 || pokemonMedicine(listItems[choice.target.slot]!)?.hp && injured && hpStock === 0)))
      decisionGoal = "Obtain affordable medicine for the party's observed needs: Antidotes cure poison; Potions restore HP. Select the matching item, then choose quantity and confirm total price separately. Maintain a small reserve when affordable, preserving money for capture balls. A purchase menu is not healing; select an item and its party target afterward.";
    else if (menu === "shop" && balls === 0 && choices.some(choice => choice.description.startsWith("Priority:"))) decisionGoal = "Obtain missing capture balls before more wild encounters. Select an affordable, storable ball from this BUY list; Jev must separately choose quantity and confirm the total price. Selecting an item does not buy it.";
    else if (menu === "shop" && choices.some(choice => choice.description.startsWith("Priority: obtain"))) decisionGoal = "Review affordable medicine reserves: around two HP-restoring items and two Antidotes when available and useful. Consider current HP/status, stock, money and bag capacity; preserve funds for needed balls. Choose item, quantity and total-price confirmation separately. Do not repeatedly buy after supplies reach the desired reserve.";
    else if (menu === "quantity") decisionGoal = "Choose the Mart quantity using the current displayed value, price, money and bag capacity, then proceed to the separate total-price confirmation. Do not repeat quantity adjustments without a purchase plan.";
    else if (shopContext && pokemonMedicine(u8(this.layout.whichPokemon - 1))) decisionGoal = "Review the selected medicine, quantity and total price against current stock, money and bag capacity before confirming the purchase. Keep a small useful reserve without spending funds needed for balls. A menu change is not a purchase or healing; inspect inventory, then explicitly choose a medicine and party target if needed.";
    else if (shopContext && balls === 0) decisionGoal = "Continue obtaining missing capture supplies through this shop prompt. Review the displayed item, quantity and total price against money and bag capacity before choosing a confirmation. A prompt or menu change does not prove that balls were purchased; inspect inventory afterward.";
    if (medicineNeeded && ["command", "moves", "overworld", "start", "bag"].includes(menu)) decisionGoal = menu === "bag" ?
      "Treat the injured or status-affected member with a beneficial medicine. Choose a suitable choose_medicine_slot action, then its party slot in the next observation. A Potion does not cure poison; an Antidote does not restore HP. Recheck HP/status and inventory after use; do not confuse opening menus with recovery." :
      "Prioritize a useful medicine already in the bag for the party's observed injury or status. Choose open_medicine_bag, then the suitable item and its exact party slot separately. Outside battle, 50% HP or less needs attention; in battle urgent low HP/status can justify treatment. Inspect recovery afterward and still consider a Center for PP or fainted members.";
    this.snapshot = { context, menu, commandX: Number(state.menuCursorX), commandY: Number(state.menuCursorY), selected: menu === "quantity" ? quantity : menu === "use" ? cursor : menu === "start" ? Number(state.menuCursorY) : selected, canConfirm,
      ...(itemRow !== undefined ? { itemRow } : {}),
      slots: choices.flatMap(choice => "slot" in choice.target ? [choice.target.slot] : []), choices, stateKey: stateKey({ ...state, ...values }) };
    return finish();
  }
  actions(state: GameState): readonly AgentAction[] {
    if (!this.contextKey(state)) return [];
    return this.snapshot!.choices.map(choice => ({ id: choice.id, description: choice.description, buttons: [], frames: 600,
      stop: false, execution: "profile", availabilityKey: `${this.snapshot!.context}:${choice.id}` }));
  }
  allows(state: GameState, button: string): boolean {
    if (!this.contextKey(state)) return true;
    if (this.snapshot!.menu === "pending") return false;
    if (["bag", "shop", "quantity", "use"].includes(this.snapshot!.menu)) return ["A", "B", "UP", "DOWN"].includes(button) && (button !== "A" || this.snapshot!.canConfirm);
    return true;
  }
}

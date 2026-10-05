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
  private snapshot: Snapshot | undefined;
  constructor(private readonly layout: PokemonItemLayout, private readonly mon: GenerationOneLayout,
    private readonly battle: PokemonBattleLayout) {
    this.catalog = new PokemonItemCatalog(layout);
    for (const [name, address] of Object.entries(layout)) if (!Number.isSafeInteger(address) ||
      (["names", "prices"].includes(name) ? address < 0 || address >= 8 * 1024 * 1024 : address < 0xc000 || address > 0xdfff)) {
      throw new Error("Invalid Generation I item layout.");
    }
  }
  reset(): void { this.catalog.reset(); this.snapshot = undefined; }
  executionState(): PokemonItemExecutionState | undefined { return this.snapshot; }
  contextKey(state: GameState): string | undefined { return this.snapshot?.stateKey === stateKey(state.values) ? this.snapshot.context : undefined; }
  target(id: string): PokemonItemTarget | undefined { return this.snapshot?.choices.find(choice => choice.id === id)?.target; }
  pending(state: GameStateData): boolean { return this.snapshot?.stateKey === stateKey(state.values) && this.snapshot.menu === "pending"; }
  list(state: GameState): boolean { return this.contextKey(state) !== undefined && ["bag", "shop", "quantity", "pending"].includes(this.snapshot!.menu); }
  quantity(state: GameState): boolean { return this.contextKey(state) !== undefined && this.snapshot!.menu === "quantity"; }

  read(memory: GameReaderMemory, ram: Uint8Array, state: Readonly<Record<string, StateValue>>): GameStateData {
    this.snapshot = undefined;
    const values: Record<string, StateValue> = {}, descriptions: Record<string, string> = {};
    const facts: string[] = [], actionFacts: Record<string, string[]> = {};
    const finish = (): GameStateData => ({ values, descriptions, decisionSupport: { facts, actionFacts } });
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
    const player = ram.subarray(this.mon.battleMon - 0xc000, this.mon.battleMon - 0xc000 + 29);
    const enemy = ram.subarray(this.mon.enemyMon - 0xc000, this.mon.enemyMon - 0xc000 + 29);
    const alive = (data: Uint8Array) => data[0]! > 0 && data[0]! <= 190 && data[14]! >= 1 && data[14]! <= 100 &&
      data[1]! * 256 + data[2]! > 0 && data[1]! * 256 + data[2]! <= data[15]! * 256 + data[16]!;
    const tower = Number(state.mapId) >= 0x90 && Number(state.mapId) <= 0x94;
    // The scripted Marowak in Tower 6F is not capturable, even after obtaining the Scope.
    const ghost = tower && (!items.some(item => item.id === 0x48) || state.mapId === 0x93 && u8(this.layout.enemySpecies) === 0x91);
    const capture = normalBattle && state.battleKind === "wild" && validBag && balls! > 0 && alive(player) && alive(enemy) &&
      u8(this.layout.enemySpecies) === enemy[0] && partyCount >= 1 && partyCount <= 6 &&
      (partyCount < 6 || boxCount < 20) && !ghost;
    if (normalBattle && state.battleKind === "wild" && alive(enemy)) {
      facts.push(`Wild capture evidence: HP ${enemy[1]! * 256 + enemy[2]!}/${enemy[15]! * 256 + enemy[16]!}; status byte ${enemy[4]}; catch-rate threshold ${u8(this.layout.catchRate)}/255 (not a success percentage). Lower HP, sleep/freeze and other supported status conditions improve ordinary captures. Defeating the enemy prevents capturing it; choose attacks that will not knock it out if you want to catch it.`);
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
    const bagList = normalBattle && validBag && pointer === this.mon.bagCount && listId === 3 && listCount === count && u8(this.layout.printPrices) === 0;
    const shopContext = !normalBattle && ["menu", "text"].includes(String(state.phase)) && pointer === this.layout.itemList && listId === 2 &&
      listCount === u8(this.layout.itemList) && listCount >= 1 && listCount <= 14 && u8(this.layout.printPrices) === 1;
    const shopList = shopContext && state.phase === "menu";
    const tiles = ram.subarray(this.mon.tileMap - 0xc000, this.mon.tileMap - 0xc000 + 360);
    const row = (y: number, x: number, length: number) => decodeName(Uint8Array.from([...tiles.subarray(y * 20 + x, y * 20 + x + length), 0x50]));
    const quantityOverlay = tiles[9 * 20 + 7] === 0x79 && tiles[9 * 20 + 19] === 0x7b;
    const listVariables = u8(this.battle.menuY) === 4 && u8(this.battle.menuX) === 5 &&
      u8(this.battle.menuMax) === (listCount < 2 ? 1 : 2) && (u8(this.battle.watchedKeys) & 7) === 7 && u8(this.battle.swappingMove) === 0;
    const scroll = u8(this.layout.scroll), cursor = u8(this.battle.menuItem), selected = scroll + cursor;
    const listItems = shopContext ? Array.from({ length: listCount }, (_, slot) => u8(this.layout.itemList + slot + 1)) : items.map(item => item.id);
    const context = createHash("sha256").update(JSON.stringify([
      state.phase, state.mapId, state.battleKind, state.battleType, partyCount, boxCount, state.money, items,
      ...(normalBattle ? [...player, ...enemy, u8(this.layout.catchRate), u8(this.layout.enemySpecies)] : []),
      ...(shopContext ? listItems : []),
    ])).digest("hex").slice(0, 24);
    const visible = (bagList || shopList) && !quantityOverlay && listVariables && scroll <= listCount && Array.from({ length: Math.min(4, listCount - scroll + 1) }, (_, i) => {
      const name = scroll + i === listCount ? "CANCEL" : this.catalog.name(listItems[scroll + i]!);
      return name !== undefined && row(4 + i * 2, 6, 13) === name;
    }).every(Boolean);
    const ready = visible && cursor <= u8(this.battle.menuMax) && selected <= listCount && tiles[(4 + cursor * 2) * 20 + 5] === 0xed;
    if (ready) menu = bagList ? "bag" : "shop";
    else if (visible) menu = "pending";
    const quantity = u8(this.layout.quantity);
    if (shopContext && quantityOverlay && quantity >= 1 && quantity <= 99 && tiles[10 * 20 + 8] === 0xf1 &&
      tiles[10 * 20 + 9] === 0xf6 + Math.floor(quantity / 10) && tiles[10 * 20 + 10] === 0xf6 + quantity % 10) {
      menu = "quantity";
      facts.push("Mart quantity prompt: " + quantity + " selected. UP increases the quantity; DOWN decreases it, wrapping between 1 and 99. A accepts this quantity and opens a price confirmation; it does not yet purchase. B cancels. Check total price and bag capacity before confirming YES.");
      actionFacts.press_a = ["A accepts quantity " + quantity + "; Jev must separately confirm the total price."];
      actionFacts.press_up = ["Increase quantity " + quantity + " by one (99 wraps to 1)."];
      actionFacts.press_down = ["Decrease quantity " + quantity + " by one (1 wraps to 99)."];
    }
    const choices: Snapshot["choices"][number][] = [];
    const canConfirm = menu !== "bag" || selected === count || !ball(items[selected]!.id) || capture;
    if (capture && ["command", "moves"].includes(menu)) choices.push({ target: { kind: "bag" }, id: "open_capture_bag",
      description: "Open ITEM in this wild battle to inspect capture balls. Do not throw anything yet; Jev chooses a ball in the next observation." });
    if (menu === "bag" && capture) items.forEach((item, slot) => {
      if (ball(item.id)) choices.push({ target: { kind: "ball", slot }, id: `throw_ball_slot_${slot + 1}`,
        description: `Throw one ${this.catalog.name(item.id) ?? `ballId=${item.id}`} from bag slot ${slot + 1} (${item.quantity} left). ${item.id === 1 ? "Master Ball is a scarce guaranteed capture for an eligible target." : item.id === 2 ? "Ultra Ball is stronger than a Poke Ball." : item.id === 3 ? "Great Ball improves ordinary captures over a Poke Ball." : "Ordinary Poke Ball; success is not guaranteed."} Navigate to exactly this slot and confirm once.` });
    });
    if (menu === "shop") {
      facts.push("Verified Mart BUY list. Choosing an item opens the quantity prompt; Jev must separately choose quantity and confirm the total price. UP increases quantity, DOWN decreases it, A proceeds, B cancels. A later YES confirms the purchase. Selling is a different menu.");
      listItems.forEach((id, slot) => {
        const price = this.catalog.price(id), name = this.catalog.name(id), existing = items.find(item => item.id === id);
        const capacity = validBag ? existing ? 99 - existing.quantity : count < 20 ? 99 : 0 : undefined;
        const affordable = price !== undefined && typeof state.money === "number" ? Math.floor(state.money / price) : undefined;
        const limit = capacity !== undefined && affordable !== undefined ? Math.min(capacity, affordable, 99) : undefined;
        facts.push(`Shop slot${slot + 1}: ${name ?? `itemId=${id}`}; unit price ${price ?? "unknown"}; currently affordable/storable quantity ${limit ?? "unknown"}.`);
        if (name && limit !== undefined && limit > 0) choices.push({ target: { kind: "shop", slot }, id: `choose_shop_item_slot_${slot + 1}`,
          description: `Select ${name} at Mart slot ${slot + 1}, unit price ${price}; at most ${limit} currently affordable/storable. Open its quantity prompt with one confirmation; do not automatically buy or choose a quantity.` });
      });
    }
    if (menu === "bag") {
      facts.push("The battle bag is open. throw_ball_slot_N throws exactly one selected ball; B returns to battle commands. Other items still require Jev's explicit menu choices. SELECT reordering is excluded in this verified capture menu.");
      actionFacts.press_a = [selected === count ? "A selects CANCEL, returning to battle commands." : `A uses bag slot ${selected + 1}: ${this.catalog.name(items[selected]!.id) ?? `itemId=${items[selected]!.id}`} x${items[selected]!.quantity}.`];
    }
    for (const choice of choices) actionFacts[choice.id] = [choice.description];
    this.snapshot = { context, menu, commandX: Number(state.menuCursorX), commandY: Number(state.menuCursorY), selected: menu === "quantity" ? quantity : selected, canConfirm,
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
    if (["bag", "shop", "quantity"].includes(this.snapshot!.menu)) return ["A", "B", "UP", "DOWN"].includes(button) && (button !== "A" || this.snapshot!.canConfirm);
    return true;
  }
}

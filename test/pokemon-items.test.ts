import assert from "node:assert/strict";
import { test } from "node:test";
import { controllerActions, validateAgentActions } from "../src/core/actions.js";
import type { GameState } from "../src/core/agent.js";
import { validateGameState } from "../src/core/game-state.js";
import { GAME_BOY_DESCRIPTOR } from "../src/emulator/game-boy/game-boy-emulator.js";
import { createPokemonRedReader, POKEMON_RED_LAYOUT } from "../src/profiles/pokemon/red.js";
import { createPokemonBlueReader } from "../src/profiles/pokemon/blue.js";
import { createPokemonYellowReader, POKEMON_YELLOW_LAYOUT } from "../src/profiles/pokemon/yellow.js";
import { RED_BLUE_ITEMS, YELLOW_ITEMS } from "../src/profiles/pokemon/item-layout.js";
import { RED_BLUE_BATTLE, YELLOW_BATTLE } from "../src/profiles/pokemon/battle-layout.js";
import { pokemonItemExecution, type PokemonItemExecutionState } from "../src/profiles/pokemon/item-execution.js";
import type { Emulator, MemoryReader, RomReader } from "../src/core/emulator.js";
import { createDefaultGameReaderRegistry } from "../src/profiles/default-registry.js";
import { createStateObserver } from "../src/observation/state.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { runAgentHeadless } from "../src/runner/agent-headless.js";
import { RequestBudget } from "../src/providers/requests.js";
import { evaluationRequest } from "../src/jev/evaluation.js";

const variants = [
  { name: "Red", mon: POKEMON_RED_LAYOUT, items: RED_BLUE_ITEMS, battle: RED_BLUE_BATTLE, create: createPokemonRedReader },
  { name: "Blue", mon: POKEMON_RED_LAYOUT, items: RED_BLUE_ITEMS, battle: RED_BLUE_BATTLE, create: createPokemonBlueReader },
  { name: "Yellow", mon: POKEMON_YELLOW_LAYOUT, items: YELLOW_ITEMS, battle: YELLOW_BATTLE, create: createPokemonYellowReader },
];
const encode = (text: string) => [...text].map(character => character === " " ? 0x7f : character.charCodeAt(0) - 65 + 0x80);
const itemNames = new Map([[1, "BALLONE"], [2, "BALLTWO"], [3, "BALLTHREE"], [4, "BALLFOUR"], [8, "ODDBALL"], [20, "MEDICINE"]]);
const buttons = controllerActions(GAME_BOY_DESCRIPTOR.buttons, 24);

/** Invented cartridge names/prices and a menu simulator. No commercial assets. */
class ItemFixture {
  readonly romBytes = new Uint8Array(64 * 0x4000);
  readonly romByteLength = this.romBytes.length;
  ram = new Uint8Array(0x10000);
  reads = 0;
  confirmations: number[] = [];
  inputs: string[] = [];
  mode: "command" | "bag" | "shop" | "result" = "command";
  private previous = "";
  constructor(readonly variant = variants[0]!) {
    const { mon, items } = variant;
    this.ram[0xff40] = 0x80; this.ram[mon.statusFlags6] = 1;
    this.ram.set([...encode("PLAYER"), 0x50], mon.playerName);
    this.ram[mon.mapWidth] = 4; this.ram[mon.mapHeight] = 4; this.ram[mon.mapId] = 13;
    this.ram[mon.partyCount] = 1; this.monster(mon.partyMons, true);
    this.monster(mon.battleMon); this.monster(mon.enemyMon);
    this.ram[mon.enemyMon] = 19; this.ram[mon.enemyMon + 5] = 0; this.ram[mon.enemyMon + 6] = 0;
    this.ram[items.enemySpecies] = 19; this.ram[items.catchRate] = 220; this.ram[mon.battleKind] = 1;
    this.ram.set([0, 0x10, 0], mon.money);
    let offset = items.names;
    for (let id = 1; id <= 83; id++) {
      const name = itemNames.get(id) ?? "UNKNOWN";
      this.romBytes.set([...encode(name), 0x50], offset); offset += name.length + 1;
    }
    this.romBytes.set([0, 2, 0], items.prices + 3 * 3); // Invented price: 200.
    this.romBytes.set([0, 3, 0], items.prices + 19 * 3);
    this.bag([[20, 2], [4, 5], [3, 2], [8, 10]]);
    this.command(15, 14);
  }
  monster(address: number, party = false) {
    this.ram[address] = 176; this.ram[address + 2] = 10; this.ram[address + 5] = 20; this.ram[address + 6] = 20;
    this.ram[address + (party ? 33 : 14)] = 5; this.ram[address + (party ? 35 : 16)] = 20;
  }
  bag(entries: readonly (readonly [number, number])[]) {
    this.ram[this.variant.mon.bagCount] = entries.length;
    this.ram.set([...entries.flat(), 255], this.variant.mon.bagItems);
  }
  box(x: number, y: number, right: number, bottom: number, clear = true) {
    const tiles = this.ram.subarray(this.variant.mon.tileMap, this.variant.mon.tileMap + 360);
    if (clear) tiles.fill(0x7f);
    for (let row = y; row <= bottom; row++) {
      tiles[row * 20 + x] = row === y ? 0x79 : row === bottom ? 0x7d : 0x7c;
      tiles[row * 20 + right] = row === y ? 0x7b : row === bottom ? 0x7e : 0x7c;
      if (row === y || row === bottom) tiles.fill(0x7a, row * 20 + x + 1, row * 20 + right);
    }
    return tiles;
  }
  command(x = 9, y = 14) {
    this.mode = "command";
    const tiles = this.box(8, 12, 19, 17);
    tiles.set(encode("FIGHT"), 14 * 20 + 10); tiles.set(encode("ITEM"), 16 * 20 + 10);
    tiles.set(encode("PKM"), 14 * 20 + 16); tiles.set(encode("RUN"), 16 * 20 + 16);
    tiles[y * 20 + x] = 0xed;
  }
  list(shop = false, selected = 0) {
    const { mon, items, battle } = this.variant;
    this.mode = shop ? "shop" : "bag";
    if (shop) { this.ram[mon.battleKind] = 0; this.ram[mon.mapId] = 42; this.ram.set([2, 4, 20, 255], items.itemList); }
    const count = shop ? this.ram[items.itemList]! : this.ram[mon.bagCount]!;
    const pointer = shop ? items.itemList : mon.bagCount;
    this.ram.set([pointer & 255, pointer >> 8], items.listPointer);
    this.ram[items.listId] = shop ? 2 : 3; this.ram[items.listCount] = count; this.ram[items.printPrices] = shop ? 1 : 0;
    this.ram[battle.menuY] = 4; this.ram[battle.menuX] = 5; this.ram[battle.menuMax] = count < 2 ? 1 : 2;
    this.ram[battle.watchedKeys] = 7;
    this.ram[items.scroll] = Math.max(0, selected - 2); this.ram[battle.menuItem] = selected - this.ram[items.scroll]!;
    const tiles = this.box(4, 2, 19, 12);
    for (let row = 0; row < 4 && row + this.ram[items.scroll]! <= count; row++) {
      const slot = row + this.ram[items.scroll]!;
      const id = shop ? this.ram[items.itemList + slot + 1]! : this.ram[mon.bagItems + slot * 2]!;
      tiles.set(encode(slot === count ? "CANCEL" : itemNames.get(id) ?? "UNKNOWN"), (4 + row * 2) * 20 + 6);
    }
    tiles[(4 + this.ram[battle.menuItem]! * 2) * 20 + 5] = 0xed;
  }
  readMemory(address: number, length: number) { return this.ram.slice(address, address + length); }
  readRom(offset: number, length: number) { assert.ok(length <= 0x4000 && offset >= 0 && offset + length <= this.romByteLength); this.reads++; return this.romBytes.slice(offset, offset + length); }
  advance(button: string) {
    this.inputs.push(button);
    if (button && button !== this.previous) {
      const { mon, items, battle } = this.variant;
      if (this.mode === "command") {
        const index = this.ram.subarray(mon.tileMap, mon.tileMap + 360).indexOf(0xed);
        if (button === "LEFT") this.command(9, Math.floor(index / 20));
        if (button === "DOWN") this.command(index % 20, 16);
        if (button === "A" && index === 16 * 20 + 9) this.list();
      } else if (this.mode === "bag" || this.mode === "shop") {
        const selected = this.ram[items.scroll]! + this.ram[battle.menuItem]!, count = this.ram[items.listCount]!;
        if (button === "DOWN") this.list(this.mode === "shop", Math.min(count, selected + 1));
        if (button === "UP") this.list(this.mode === "shop", Math.max(0, selected - 1));
        if (button === "A") {
          this.confirmations.push(selected);
          if (this.mode === "bag") { this.ram[mon.bagItems + selected * 2 + 1]!--; this.box(0, 12, 19, 17); }
          else this.box(7, 9, 19, 11, false);
          this.mode = "result";
        }
      }
    }
    this.previous = button;
  }
}
function snapshot(fixture: ItemFixture, reader = fixture.variant.create()): GameState {
  const state = { ...reader.readState(fixture), source: reader.descriptor.id, frame: 0 };
  validateGameState(state, 0); return state;
}

function prepareCaptureFixture(fixture: ItemFixture): void {
  const { mon, battle } = fixture.variant;
  const put16 = (address: number, value: number) => fixture.ram.set([value >> 8, value & 255], address);
  for (const address of [mon.battleMon, mon.enemyMon]) {
    put16(address + 1, 100); put16(address + 15, 100);
    fixture.ram[address + 14] = 10; fixture.ram[address + 5] = 0; fixture.ram[address + 6] = 0;
    put16(address + 17, 40); put16(address + 19, 20); put16(address + 23, 20);
  }
  fixture.ram[mon.partyMons + 33] = 10; put16(mon.partyMons + 34, 100);
  put16(mon.partyMons + 36, 40); put16(mon.partyMons + 42, 20);
  fixture.ram[battle.enemyUnmodifiedLevel] = 10; put16(battle.enemyUnmodifiedStats, 100);
  put16(battle.enemyUnmodifiedStats + 4, 20); put16(battle.enemyUnmodifiedStats + 8, 20);
  fixture.ram.fill(7, battle.playerStages, battle.playerStages + 6);
  fixture.ram.fill(7, battle.enemyStages, battle.enemyStages + 6);
  fixture.ram.set([1, 2, 3, 4], mon.battleMon + 8); fixture.ram.set([20, 20, 20, 20], mon.battleMon + 25);
  fixture.romBytes.fill(0x50, battle.moveNames, battle.moveNames + 4096);
  fixture.romBytes.set([...["SOFTTAP", "HEAVYHIT", "SLEEPCALL", "ODDHIT"].flatMap(name => [...encode(name), 0x50])], battle.moveNames);
  for (const [index, power, effect] of [[0, 20, 0], [1, 250, 0], [2, 0, 0x20], [3, 1, 0x29]]) {
    fixture.romBytes.set([index! + 1, effect!, power!, 0, 255, 20], battle.moves + index! * 6);
  }
  fixture.romBytes.set([0, 5, 20, 0xff], battle.typeEffects);
  fixture.bag([[4, 5]]); fixture.command();
}
function execute(fixture: ItemFixture, reader: ReturnType<typeof createPokemonRedReader>, id: string) {
  const actions = reader.availableActions(snapshot(fixture, reader), buttons); validateAgentActions(actions, GAME_BOY_DESCRIPTOR.buttons);
  const action = actions.find(action => action.id === id); assert.ok(action, "Expected " + id);
  const execution = reader.createExecution(fixture, action);
  for (let frame = 0; frame <= 600; frame++) {
    const step = execution.next(); if (step.done) return step.reason;
    fixture.advance(step.buttons[0] ?? "");
  }
  assert.fail("Item execution must remain bounded.");
}

for (const variant of variants) {
  test(variant.name + " prepares a high-HP capture with cautious move evidence, then throws at the rounded ball plateau", () => {
    const fixture = new ItemFixture(variant), reader = variant.create(); prepareCaptureFixture(fixture);
    const before = fixture.ram.slice();
    let state = snapshot(fixture, reader), actions = reader.availableActions(state, buttons);
    assert.match(state.decisionSupport!.decisionGoal!, /one cautious ordinary attack.*Choose a cautious use_move/);
    assert.match(actions.find(action => action.id === "use_move_1")!.description, /^Priority:.*SOFTTAP/);
    assert.match(state.decisionSupport!.actionFacts.use_move_2!.join(" "), /KO risk/);
    assert.match(state.decisionSupport!.actionFacts.use_move_3!.join(" "), /no direct HP reduction/);
    assert.match(state.decisionSupport!.actionFacts.use_move_4!.join(" "), /not estimated/);
    assert.match(actions.find(action => action.id === "open_capture_bag")!.description, /weakening attack is recommended first/);
    assert.deepEqual(fixture.ram, before, "Reading capture tasks and actions never changes RAM.");
    fixture.list(); state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.decisionGoal!, /choose B to leave the bag/);
    assert.match(state.decisionSupport!.actionFacts.press_b!.join(" "), /cautious weakening/);
    assert.ok(reader.availableActions(state, buttons).some(action => action.id === "throw_ball_slot_1"), "An early throw remains Jev's legal choice.");
    fixture.ram[variant.mon.enemyMon + 2] = 35; fixture.command(); state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.decisionGoal!, /maximum HP benefit.*Choose open_capture_bag/);
    assert.ok(!state.decisionSupport!.actionFacts.use_move_1!.some(note => /^Priority:/.test(note)));
    fixture.list(); state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.decisionGoal!, /select one available throw_ball_slot/);
    const ball = reader.availableActions(state, buttons).find(action => action.id === "throw_ball_slot_1")!;
    assert.match(ball.description, /capture estimate.*HP benefit already maximized/);
    validateAgentActions(reader.availableActions(state, buttons), GAME_BOY_DESCRIPTOR.buttons);
    assert.equal(fixture.inputs.length, 0);
  });

  test(variant.name + " stops weakening for Great Ball plateaus and risky, disabled, depleted or unknown attacks", () => {
    const fixture = new ItemFixture(variant), reader = variant.create(); prepareCaptureFixture(fixture);
    fixture.bag([[3, 2]]); fixture.ram[variant.mon.enemyMon + 2] = 51;
    let state = snapshot(fixture, reader); assert.match(state.decisionSupport!.decisionGoal!, /maximum HP benefit/);
    fixture.bag([[4, 2]]); state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.decisionGoal!, /Choose a cautious use_move/);
    fixture.ram[variant.mon.enemyMon + 2] = 40;
    fixture.ram[variant.mon.battleMon + 25] = 0; state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.decisionGoal!, /No cautious ordinary attack.*Choose open_capture_bag/);
    fixture.ram[variant.mon.battleMon + 25] = 20; fixture.ram[variant.battle.disabledMove] = 0x12;
    state = snapshot(fixture, reader); assert.match(state.decisionSupport!.decisionGoal!, /No cautious ordinary attack/);
    fixture.ram[variant.battle.disabledMove] = 0; fixture.ram[variant.battle.enemyUnmodifiedStats + 4] = 0;
    fixture.ram[variant.battle.enemyUnmodifiedStats + 5] = 0; state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.decisionGoal!, /No cautious ordinary attack/);
    assert.match(state.decisionSupport!.actionFacts.use_move_1!.join(" "), /critical upper estimate unknown/);
    fixture.ram[variant.mon.battleKind] = 2; state = snapshot(fixture, reader);
    assert.doesNotMatch(state.decisionSupport!.facts.join(" "), /Capture preparation: enemy HP/);
  });

  test(variant.name + " avoids additional capture turns during residual damage and refreshes late move meanings", () => {
    const fixture = new ItemFixture(variant), reader = variant.create(); prepareCaptureFixture(fixture);
    let state = snapshot(fixture, reader);
    const old = reader.availableActions(state, buttons).find(action => action.id === "use_move_1")!;
    fixture.ram[variant.battle.enemyBattleStatus3] = 4; state = snapshot(fixture, reader);
    assert.notEqual(reader.availableActions(state, buttons).find(action => action.id === old.id)!.availabilityKey, old.availabilityKey);
    fixture.ram[variant.mon.enemyMon + 4] = 8; state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.decisionGoal!, /Residual damage.*Choose open_capture_bag/);
    fixture.ram[variant.mon.enemyMon + 4] = 0; fixture.ram[variant.mon.battleMon + 2] = 30; state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.decisionGoal!, /30% HP or less.*Choose open_capture_bag/);
    fixture.ram[variant.mon.battleMon + 2] = 100; fixture.bag([]); state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.decisionGoal!, /Capture is currently unavailable/);
    assert.doesNotMatch(state.decisionSupport!.facts.join(" "), /Capture preparation: enemy HP/);
  });

  test(variant.name + " capture risk uses live modified stats once and unmodified critical stats", () => {
    const fixture = new ItemFixture(variant), reader = variant.create(); prepareCaptureFixture(fixture);
    let state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.actionFacts.use_move_1!.join(" "), /ordinary hit 5-9 HP; critical upper estimate 15 HP/);
    fixture.ram[variant.mon.battleMon + 18] = 5; fixture.ram[variant.battle.playerStages] = 1;
    state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.actionFacts.use_move_1!.join(" "), /ordinary hit 1-3 HP; critical upper estimate 15 HP/);
    fixture.ram[variant.mon.battleMon + 18] = 40; fixture.ram[variant.battle.playerStages] = 7;
    fixture.ram[variant.battle.enemyBattleStatus3] = 4; state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.actionFacts.use_move_1!.join(" "), /ordinary hit 3-6 HP; critical upper estimate 15 HP/);
    fixture.ram[variant.mon.enemyMon + 2] = 15; state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.actionFacts.use_move_1!.join(" "), /KO risk/);
    fixture.ram[variant.mon.enemyMon + 2] = 100;
    fixture.ram[variant.mon.partyMons] = 177; state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.decisionGoal!, /No cautious ordinary attack/);
  });

  test(variant.name + " capture preparation distinguishes physical and special moves, STAB, distinct types and unknown charts", () => {
    const fixture = new ItemFixture(variant), reader = variant.create(); prepareCaptureFixture(fixture);
    fixture.romBytes[variant.battle.moves + 3] = 20;
    fixture.romBytes.set([20, 0, 20, 20, 5, 5, 0xff], variant.battle.typeEffects);
    fixture.ram[variant.mon.enemyMon + 6] = 5;
    let state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.actionFacts.use_move_1!.join(" "), /ordinary hit 1-4 HP; critical upper estimate 6 HP/);
    fixture.ram[variant.mon.enemyMon + 6] = 0; state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.actionFacts.use_move_1!.join(" "), /ordinary hit 4-8 HP; critical upper estimate 12 HP/);
    fixture.ram[variant.mon.battleMon + 5] = 20; fixture.ram[variant.mon.battleMon + 6] = 20; state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.actionFacts.use_move_1!.join(" "), /ordinary hit 8-12 HP; critical upper estimate 18 HP/);
    fixture.romBytes.fill(0, variant.battle.typeEffects, variant.battle.typeEffects + 384); reader.reset(); state = snapshot(fixture, reader);
    assert.match(state.decisionSupport!.decisionGoal!, /No cautious ordinary attack/);
    assert.match(state.decisionSupport!.actionFacts.use_move_1!.join(" "), /type chart are invalid/);
  });

  test(variant.name + " prioritizes an eligible species absent from the team independently of types and Pokedex ownership", () => {
    const fixture = new ItemFixture(variant), reader = variant.create();
    fixture.ram[variant.mon.enemyMon + 5] = 20; fixture.ram[variant.mon.enemyMon + 6] = 20;
    fixture.ram.fill(255, variant.mon.pokedexOwned, variant.mon.pokedexOwned + 19);
    let state = snapshot(fixture, reader), actions = reader.availableActions(state, buttons);
    assert.match(actions.find(action => action.id === "open_capture_bag")!.description, /^Priority: capture this species absent from the team/);
    assert.ok(state.decisionSupport!.facts.slice(0, 5).some(fact => /Priority: attempt to capture this eligible wild species/.test(fact)));
    assert.match(state.decisionSupport!.actionFacts.use_move_1!.join(" "), /Pokedex ownership and shared types/);
    fixture.list(); state = snapshot(fixture, reader);
    assert.match(reader.availableActions(state, buttons).find(action => action.id === "throw_ball_slot_2")!.description, /^Priority:/);
    fixture.command(); fixture.ram[variant.mon.enemyMon] = 176; fixture.ram[variant.items.enemySpecies] = 176;
    state = snapshot(fixture, reader);
    assert.ok(reader.availableActions(state, buttons).some(action => action.id === "open_capture_bag"));
    assert.doesNotMatch(reader.availableActions(state, buttons).find(action => action.id === "open_capture_bag")!.description, /^Priority:/);
    fixture.ram[variant.mon.enemyMon] = 19; fixture.ram[variant.items.enemySpecies] = 19;
    fixture.ram[variant.mon.partyMons + 33] = 0; state = snapshot(fixture, reader);
    assert.doesNotMatch(reader.availableActions(state, buttons).find(action => action.id === "open_capture_bag")!.description, /^Priority:/);
    fixture.ram[variant.mon.partyMons + 33] = 5; fixture.bag([[20, 2]]); state = snapshot(fixture, reader);
    assert.ok(!reader.availableActions(state, buttons).some(action => action.id === "open_capture_bag"));
    assert.match(state.decisionSupport!.facts.join(" "), /Priority: this eligible wild species.*Buy balls at a Mart/);
    assert.match(state.decisionSupport!.decisionGoal!, /Capture is currently unavailable.*damaging move or an escape attempt/);
    assert.ok(!state.decisionSupport!.actionFacts.use_move_1?.some(fact => /If you want this wild Pokemon/.test(fact)));
    assert.doesNotMatch(state.decisionSupport!.facts.join(" "), /Avoid knocking out a desired capture|choose attacks that will not knock it out/);
    fixture.ram[variant.mon.battleKind] = 2; state = snapshot(fixture, reader);
    assert.doesNotMatch(state.decisionSupport!.facts.join(" "), /Priority: (attempt to capture this eligible|this eligible wild species)/);
    fixture.list(true); state = snapshot(fixture, reader);
    assert.match(reader.availableActions(state, buttons).find(action => action.id === "choose_shop_item_slot_1")!.description, /^Priority: buy missing capture balls/);
    assert.match(state.decisionSupport!.decisionGoal!, /Obtain missing capture balls.*separately choose quantity/);
    assert.equal(fixture.confirmations.length, 0, "Reading priorities never buys or throws anything.");
  });

  test(variant.name + " exposes bounded inventory names, ordinary ball counts and team evidence without writes", () => {
    const fixture = new ItemFixture(variant), reader = variant.create(), before = fixture.ram.slice();
    const state = snapshot(fixture, reader), facts = state.decisionSupport!.facts.join(" ");
    assert.equal(state.values.pokeBalls, 7); assert.match(facts, /BALLFOUR x5.*BALLTHREE x2/);
    assert.match(facts, /only one party member.*HP, levels, move PP/); assert.match(facts, /Defeating the enemy prevents capturing/);
    assert.match(facts, /type coverage.*Normal/); assert.deepEqual(fixture.ram, before);
    const reads = fixture.reads; snapshot(fixture, reader); assert.equal(fixture.reads, reads);
    reader.reset(); snapshot(fixture, reader); assert.ok(fixture.reads > reads);
    fixture.bag([]); const empty = snapshot(fixture, reader);
    assert.equal(empty.values.pokeBalls, 0); assert.match(empty.decisionSupport!.facts.join(" "), /Capturing is currently impossible/);
    assert.ok(!reader.availableActions(empty, buttons).some(action => action.id === "open_capture_bag"));
    fixture.bag([[4, 100]]); assert.equal(snapshot(fixture, reader).values.pokeBalls, "unknown");
  });

  test(variant.name + " opens the bag and confirms only the selected ball, guarding stale inventory and highlights", () => {
    const fixture = new ItemFixture(variant), reader = variant.create();
    assert.match(execute(fixture, reader, "open_capture_bag"), /bag opened/); assert.deepEqual(fixture.confirmations, []);
    const initial = reader.availableActions(snapshot(fixture, reader), buttons);
    assert.deepEqual(initial.filter(action => action.id.startsWith("throw_")).map(action => action.id), ["throw_ball_slot_2", "throw_ball_slot_3"]);
    fixture.list(false, 2); const moved = reader.availableActions(snapshot(fixture, reader), buttons);
    assert.equal(moved.find(action => action.id === "throw_ball_slot_2")!.availabilityKey, initial.find(action => action.id === "throw_ball_slot_2")!.availabilityKey);
    assert.notEqual(moved.find(action => action.id === "press_a")!.availabilityKey, initial.find(action => action.id === "press_a")!.availabilityKey);
    assert.match(execute(fixture, reader, "throw_ball_slot_2"), /context changed|confirmation sent/);
    assert.deepEqual(fixture.confirmations, [1]); assert.equal(fixture.ram[variant.mon.bagItems + 3], 4);
    assert.equal(fixture.inputs.filter(button => button === "A").length, 2);
    fixture.list(); const action = reader.availableActions(snapshot(fixture, reader), buttons).find(action => action.id === "throw_ball_slot_2")!;
    const execution = reader.createExecution(fixture, action);
    fixture.ram[variant.mon.bagItems + 3]!--;
    assert.match((execution.next() as { reason: string }).reason, /context changed/);
  });

  test(variant.name + " excludes trainer/demo/Safari/ghost/dead/full-storage captures and partial menus", () => {
    const fixture = new ItemFixture(variant), reader = variant.create();
    const offered = () => reader.availableActions(snapshot(fixture, reader), buttons);
    fixture.list(false, 1); fixture.ram[variant.mon.battleKind] = 2;
    assert.ok(!offered().some(action => action.id.startsWith("throw_") || action.id === "press_a"));
    fixture.ram[variant.mon.battleKind] = 1;
    for (const type of [1, 2]) { fixture.ram[variant.mon.battleType] = type; assert.ok(!offered().some(action => action.id.startsWith("throw_"))); }
    fixture.ram[variant.mon.battleType] = 0; fixture.ram[variant.mon.enemyMon + 2] = 0;
    assert.ok(!offered().some(action => action.id.startsWith("throw_")));
    fixture.ram[variant.mon.enemyMon + 2] = 10; fixture.ram[variant.mon.mapId] = 0x90;
    assert.ok(!offered().some(action => action.id.startsWith("throw_")));
    fixture.ram[variant.mon.mapId] = 13; fixture.ram[variant.mon.partyCount] = 6; fixture.ram[variant.items.boxCount] = 20;
    for (let slot = 1; slot < 6; slot++) fixture.monster(variant.mon.partyMons + slot * 44, true);
    assert.ok(!offered().some(action => action.id.startsWith("throw_")));
    fixture.ram[variant.items.boxCount] = 19; assert.ok(offered().some(action => action.id === "throw_ball_slot_2"));
    fixture.ram[variant.mon.tileMap + 4 * 20 + 6] = 0;
    assert.ok(!offered().some(action => action.id.startsWith("throw_")));
    fixture.list(); fixture.ram[variant.mon.tileMap + 4 * 20 + 5] = 0xec;
    const pending = snapshot(fixture, reader); assert.equal(reader.shouldWait(pending, 0), true);
    assert.deepEqual(reader.availableActions(pending, buttons).map(action => action.id), ["wait", "stop"]);
  });

  test(variant.name + " selects a priced Mart item once, leaving quantity and purchase confirmation to Jev", () => {
    const fixture = new ItemFixture(variant), reader = variant.create(); fixture.list(true);
    const state = snapshot(fixture, reader); assert.match(state.decisionSupport!.facts.join(" "), /unit price 200.*quantity 5/);
    const money = fixture.readMemory(variant.mon.money, 3), bag = fixture.readMemory(variant.mon.bagItems, 8);
    assert.match(execute(fixture, reader, "choose_shop_item_slot_2"), /confirmation sent|context changed/);
    assert.deepEqual(fixture.confirmations, [1]); assert.deepEqual(fixture.readMemory(variant.mon.money, 3), money);
    assert.deepEqual(fixture.readMemory(variant.mon.bagItems, 8), bag);
    assert.ok(!reader.availableActions(snapshot(fixture, reader), buttons).some(action => action.id.startsWith("choose_shop_")));
    fixture.ram.set([0, 0, 0], variant.mon.money); fixture.list(true);
    assert.ok(!reader.availableActions(snapshot(fixture, reader), buttons).some(action => action.id.startsWith("choose_shop_")));
  });

  test(variant.name + " recognizes cursorless quantity prompts and guards their meaning and changing shop lists", () => {
    const fixture = new ItemFixture(variant), reader = variant.create(); fixture.list(true);
    const before = reader.availableActions(snapshot(fixture, reader), buttons).find(action => action.id === "choose_shop_item_slot_1")!;
    fixture.ram[variant.items.itemList + 1] = 20;
    fixture.ram.fill(0x7f, variant.mon.tileMap + 4 * 20 + 6, variant.mon.tileMap + 4 * 20 + 19);
    fixture.ram.set(encode("MEDICINE"), variant.mon.tileMap + 4 * 20 + 6);
    const changed = reader.availableActions(snapshot(fixture, reader), buttons).find(action => action.id === before.id)!;
    assert.notEqual(changed.availabilityKey, before.availabilityKey);
    const tiles = fixture.box(7, 9, 19, 11);
    fixture.ram[variant.items.quantity] = 5; tiles.set([0xf1, 0xf6, 0xfb], 10 * 20 + 8);
    const state = snapshot(fixture, reader);
    assert.equal(state.values.phase, "text"); assert.match(state.decisionSupport!.facts.join(" "), /quantity prompt: 5/);
    const actions = reader.availableActions(state, buttons); validateAgentActions(actions, GAME_BOY_DESCRIPTOR.buttons);
    assert.equal(actions.find(action => action.id === "press_a")!.frames, 1, "Quantity acceptance cannot also confirm its later price.");
    assert.ok(actions.some(action => action.id === "press_up")); assert.ok(actions.some(action => action.id === "press_down"));
    assert.ok(!actions.some(action => ["press_left", "press_right", "press_start", "press_select"].includes(action.id)));
    fixture.ram[variant.items.quantity] = 6; tiles[10 * 20 + 10] = 0xfc;
    assert.notEqual(reader.availableActions(snapshot(fixture, reader), buttons).find(action => action.id === "press_a")!.availabilityKey,
      actions.find(action => action.id === "press_a")!.availabilityKey);
    fixture.ram[variant.items.quantity] = 7; // RAM and displayed quantity no longer agree.
    assert.ok(!reader.availableActions(snapshot(fixture, reader), buttons).some(action => action.id === "press_up"));
  });
}

test("item navigation does not overshoot its selected slot when every frame repeats the direction", () => {
  let state: PokemonItemExecutionState = { context: "bag", menu: "bag", commandX: 9, commandY: 16, selected: 0, slots: [1] };
  const execution = pokemonItemExecution({ kind: "ball", slot: 1 }, () => state, 8), inputs: string[] = [];
  for (let frame = 0; frame < 100; frame++) {
    const step = execution.next(); if (step.done) break;
    const button = step.buttons[0]; if (button) inputs.push(button);
    if (button === "DOWN") state = { ...state, selected: state.selected + 1 };
  }
  assert.deepEqual(inputs, ["DOWN", "A"]); assert.equal(state.selected, 1);
});

test("item executors stop on changed context or closed menus and bound ignored controls without another choice", () => {
  let state: PokemonItemExecutionState = { context: "original", menu: "bag", commandX: 0, commandY: 0, selected: 0, slots: [1] };
  let execution = pokemonItemExecution({ kind: "ball", slot: 1 }, () => state, 8);
  state = { ...state, context: "changed" }; assert.match((execution.next() as { reason: string }).reason, /context changed/);
  execution = pokemonItemExecution({ kind: "ball", slot: 1 }, () => state, 8);
  state = { ...state, menu: "other" }; assert.match((execution.next() as { reason: string }).reason, /closed/);
  state = { ...state, menu: "bag" }; execution = pokemonItemExecution({ kind: "ball", slot: 1 }, () => state, 8);
  for (let frame = 0; frame < 600; frame++) { const next = execution.next(); assert.equal(next.done, false); if (!next.done) assert.ok(!next.buttons.includes("A")); }
  assert.match((execution.next() as { reason: string }).reason, /frame ceiling/);
});

test("a mock session passes capture facts to its decider and executes only the selected ball with a final release", async () => {
  const fixture = new ItemFixture(); fixture.list();
  let frame = 0;
  const emulator: Emulator & MemoryReader & RomReader = {
    descriptor: GAME_BOY_DESCRIPTOR,
    rom: { sha256: fixture.variant.create().descriptor.romSha256[0]!, title: "Invented item fixture", byteLength: fixture.romByteLength },
    get frameNumber() { return frame; },
    readMemory: fixture.readMemory.bind(fixture), readRom: fixture.readRom.bind(fixture),
    captureFrame() { return { number: frame, width: 160, height: 144, format: "rgba8888", pixels: new Uint8Array(160 * 144 * 4) }; },
    advance(action) { frame += action.frames; fixture.advance(action.buttons[0] ?? ""); },
    saveState() { throw Error("Unexpected checkpoint write"); }, restoreState() { throw Error("Unexpected restore"); },
    reset() { throw Error("Unexpected reset"); }, dispose() {},
  };
  const provider = createDefaultGameReaderRegistry().createFor(emulator, 24)!;
  const session = new AgentSession(emulator, { mode: "mock", visionProvider: "none", actionFrames: 24,
    objectives: { goal: "Catch the invented wild target", constraints: [], milestones: [] }, maxDecisions: 1, maxSeconds: 60,
    observer: createStateObserver(provider), budget: new RequestBudget({ maxRequests: 1, intervalMs: 0, retries: 0, timeoutMs: 1000 }),
    decider: { async decide(context) {
      const request = evaluationRequest(context, "jev-fixture");
      assert.match(request.state.gameState!.decisionSupport!.facts.join(" "), /Capture supplies: 7/);
      assert.match(request.questions.next_action.criteria.throw_ball_slot_3!, /BALLTHREE/);
      assert.match(request.questions.next_action.criteria.throw_ball_slot_3!, /Gen I capture estimate/);
      assert.ok(context.actions.some(action => action.id === "throw_ball_slot_3"));
      return { actionId: "throw_ball_slot_3", confidence: 1, probabilities: {}, model: "offline-item-fixture", usage: { inputTokens: 0, outputTokens: 0 } };
    } },
  });
  await runAgentHeadless(emulator, session, new AbortController().signal, 604);
  assert.deepEqual(fixture.confirmations, [2]); assert.equal(fixture.inputs.at(-1), "");
  assert.equal(session.snapshot.requests, 0);
});

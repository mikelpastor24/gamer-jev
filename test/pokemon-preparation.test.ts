import assert from "node:assert/strict";
import { test } from "node:test";
import { PokemonPreparationCatalog } from "../src/profiles/pokemon/preparation-catalog.js";
import { PokemonPreparationSupport } from "../src/profiles/pokemon/preparation-support.js";
import { PokemonMoveCatalog } from "../src/profiles/pokemon/move-catalog.js";
import { POKEMON_RED_LAYOUT } from "../src/profiles/pokemon/red.js";
import { POKEMON_YELLOW_LAYOUT } from "../src/profiles/pokemon/yellow.js";
import { RED_BLUE_ITEMS, YELLOW_ITEMS } from "../src/profiles/pokemon/item-layout.js";
import { PokemonItemCatalog } from "../src/profiles/pokemon/item-catalog.js";
import { preparationParty, preparationTables } from "./fixtures/pokemon-preparation.js";
import { cartridge } from "./fixtures/pokemon-world.js";
import { PokemonFocusMemory } from "../src/profiles/pokemon/focus.js";
import type { StateValue } from "../src/core/agent.js";
import { landEncounterTile } from "../src/profiles/pokemon/encounter-tiles.js";

function fixture(yellow = false) {
  const bytes = new Uint8Array(64 * 0x4000), tables = preparationTables(bytes, yellow);
  let reads = 0;
  const memory = { romByteLength: bytes.length, readMemory: () => new Uint8Array(), readRom: (offset: number, length: number) => {
    reads++; assert.ok(length <= 0x4000 && offset >= 0 && offset + length <= bytes.length); return bytes.slice(offset, offset + length);
  } };
  const layout = yellow ? POKEMON_YELLOW_LAYOUT : POKEMON_RED_LAYOUT, items = yellow ? YELLOW_ITEMS : RED_BLUE_ITEMS;
  bytes.set([0, 2, 0], items.prices + 3 * 3); // Invented item 4 price: 200.
  const itemCatalog = new PokemonItemCatalog(items); itemCatalog.load(memory);
  const catalog = new PokemonPreparationCatalog(tables.layout), moves = new PokemonMoveCatalog(tables.battle);
  const support = new PokemonPreparationSupport(layout, catalog, moves, items), ram = new Uint8Array(0x10000);
  preparationParty(ram, layout);
  const state: Record<string, StateValue> = { gameStarted: true, phase: "overworld", mapId: 2, partyCount: 1,
    pokeBalls: 0, money: 1705, bagCount: 0, badges: "Boulder", activeMilestone: "misty_and_bill" };
  return { bytes, tables, memory, catalog, moves, support, ram, layout, state, itemCatalog, reads: () => reads,
    read: () => support.read(memory, ram.subarray(0xc000, 0xe000), state, itemCatalog) };
}

for (const yellow of [false, true]) test(`${yellow ? "Yellow" : "Red/Blue"} preparation explains an injured lone starter, supplies and the exact next team`, () => {
  const f = fixture(yellow), result = f.read(), facts = result.decisionSupport!.facts.join(" ");
  assert.match(facts, /12\/47 \(26%\)/); assert.match(facts, /Healing is recommended/);
  assert.match(facts, /Only one party member/); assert.match(facts, /affordable quantity up to 8/);
  assert.match(facts, new RegExp(`RIPPLE Lv${yellow ? 22 : 21}`)); assert.match(facts, /best usable ordinary attack factor=0.5x/);
  assert.match(String(result.values.party1Moves), /VOICE,Normal,status\/special,PP=61\/61/);
  assert.equal(f.support.canBuyBalls, true); assert.equal(f.support.canStoreCapture, true);
  assert.equal(f.support.needsHealing, true); assert.equal(f.support.healthKey, "critical:false:false");
  assert.ok(f.support.encounterMaps(true).includes(12)); assert.ok(f.support.encounterMaps(true).includes(14));
  const reads = f.reads(); f.read(); assert.equal(f.reads(), reads, "Decoded immutable tables are reused.");
  const ramBefore = f.ram.slice(); f.read(); assert.deepEqual(f.ram, ramBefore, "Reading preparation never mutates RAM.");
  f.support.reset(); f.read(); assert.ok(f.reads() > reads, "Restore/reset invalidates preparation metadata.");
});

test("preparation distinguishes full HP from full PP/status recovery and excludes status moves from matchup damage", () => {
  const f = fixture(); preparationParty(f.ram, f.layout, 1, 2, 47);
  f.read(); assert.equal(f.support.restored, true); assert.equal(f.support.needsHealing, false);
  f.ram[f.layout.partyMons + 29] = 1; f.read(); assert.equal(f.support.restored, false); assert.equal(f.support.needsHealing, true);
  f.ram[f.layout.partyMons + 8] = 4; f.ram[f.layout.partyMons + 29] = 40;
  assert.match(f.read().decisionSupport!.facts.join(" "), /factor=unknown/);
  f.ram[f.layout.partyMons + 4] = 32; f.read(); assert.equal(f.support.needsHealing, true);
  f.ram[f.layout.partyMons + 4] = 128; f.read(); assert.equal(f.support.needsHealing, undefined);
  assert.match(f.read().decisionSupport!.facts.join(" "), /data are invalid/);
});

test("healing includes exactly half HP and post-battle review waits for settled valid party data", () => {
  const f = fixture(); preparationParty(f.ram, f.layout, 1, 2, 24, 48);
  assert.match(f.read().decisionSupport!.facts.join(" "), /50% HP or less/);
  assert.equal(f.support.needsHealing, true); assert.equal(f.support.healthKey, "low:false:false");
  preparationParty(f.ram, f.layout, 1, 2, 25, 48); f.read(); assert.equal(f.support.needsHealing, false);
  preparationParty(f.ram, f.layout, 1, 2, 24, 48);
  f.state.phase = "battle"; f.state.battleKind = "trainer"; f.read();
  f.state.phase = "transition"; f.state.battleKind = "none"; f.read();
  assert.equal(f.support.postBattleReview, 0);
  f.state.phase = "overworld"; f.ram[f.layout.partyMons + 33] = 0; f.read();
  assert.equal(f.support.postBattleReview, 0, "Transitional party records must not consume the pending check.");
  f.ram[f.layout.partyMons + 33] = 16; f.state.movementInProgress = true; f.read();
  assert.equal(f.support.postBattleReview, 0, "Walking does not consume a settled post-battle check.");
  f.state.movementInProgress = false; f.state.controlBusy = true; f.read();
  assert.equal(f.support.postBattleReview, 0, "Scripted control must return before reviewing the purpose.");
  f.state.controlBusy = false; f.read(); assert.equal(f.support.postBattleReview, 1);
  f.read(); f.read(); assert.equal(f.support.postBattleReview, 1, "Duplicate reads do not cause repeated reviews.");
  f.state.phase = "battle"; f.state.battleKind = "wild"; f.read();
  f.state.phase = "overworld"; f.state.battleKind = "none"; f.read();
  assert.equal(f.support.postBattleReview, 2, "A new battle reviews healing even within the same health band.");
  f.support.reset(); f.read(); assert.equal(f.support.postBattleReview, 0);
});

test("custom objectives, malformed trainer/wild records and missing type charts do not fabricate knowledge", () => {
  const f = fixture(); delete f.state.activeMilestone;
  assert.equal(f.read().values.upcomingChallenge, undefined);
  f.state.activeMilestone = "misty_and_bill"; f.bytes[f.tables.battle.typeEffects] = 255;
  f.support.reset(); assert.match(f.read().decisionSupport!.facts.join(" "), /factor=unknown/);
  f.tables.trainer(35, [255, 101, 3, 0]); f.tables.wild(14, 190);
  f.support.reset(); const result = f.read(); assert.match(String(result.values.upcomingChallenge), /unknown team/);
  assert.equal(f.catalog.landEncounters(14), undefined);
  f.tables.wild(12); f.bytes[3 * 0x4000 + 0x3000 + 12 * 24] = 0; f.support.reset(); f.read();
  assert.deepEqual(f.catalog.landEncounters(12), []);
  assert.ok(!f.catalog.ordinaryEncounterMaps().includes(12), "A known zero land rate is not an encounter destination.");
  assert.equal(f.catalog.trainer(f.memory, 48), undefined); assert.equal(f.catalog.trainer(f.memory, 29, 4), undefined);
  assert.equal(f.catalog.trainer(f.memory, 29, 3)?.[1]?.level, 50);
  f.memory.readRom = () => { throw new Error("Unavailable cartridge slice"); };
  f.support.reset(); assert.doesNotThrow(() => f.read()); assert.equal(f.catalog.landEncounters(12), undefined);
  f.state.pokeBalls = "unknown"; f.state.money = "unknown";
  assert.match(String(f.read().values.preparationNeeds), /capture supplies unknown/);
  assert.equal(f.support.canBuyBalls, false);
});

test("capture purpose survives supply purchases while urgent preparation changes require a fresh Jev choice", () => {
  const focus = new PokemonFocusMemory();
  const state = { gameStarted: true, mapId: 2, partyCount: 1, party1: "TEST; speciesId=2; level=16; HP=47/47; Fire; no status condition", bagItems: "", preparationHealthKey: "adequate:false:false" };
  focus.observe(state, "Boulder"); focus.choices(state, ["catch"]); focus.select("focus_catch").next();
  focus.observe({ ...state, bagItems: "id=4,qty=3" }, "Boulder"); assert.equal(focus.current, "catch");
  focus.observe({ ...state, bagItems: "id=4,qty=3", preparationHealthKey: "critical:false:false" }, "Boulder"); assert.equal(focus.needsChoice, true);
});

test("healing focus requires observed PP restoration and a storage capture reconsiders team purpose", () => {
  const focus = new PokemonFocusMemory();
  const state = { gameStarted: true, mapId: 58, partyCount: 1, party1: "TEST; speciesId=2; level=16; HP=40/47; Fire; no status condition",
    party1Moves: "BURN PP=12/15", preparationHealthKey: "adequate:false:false", partyRestored: false, pokedexOwned: 1 };
  focus.observe(state, "Boulder"); focus.choices(state, ["heal"]); focus.select("focus_heal").next();
  const fullHP = { ...state, party1: state.party1.replace("40/47", "47/47") };
  focus.observe(fullHP, "Boulder"); assert.equal(focus.current, "heal", "Full HP alone does not verify PP recovery.");
  focus.observe({ ...fullHP, partyRestored: true, party1Moves: "BURN PP=15/15" }, "Boulder"); assert.equal(focus.needsChoice, true);
  focus.choices(fullHP, ["catch"]); focus.select("focus_catch").next();
  focus.observe({ ...fullHP, pokedexOwned: 2 }, "Boulder"); assert.equal(focus.needsChoice, true, "An owned species change also covers captured Pokemon sent to storage.");
});

test("ground encounter tiles preserve Red/Blue versus Yellow half-block rules and exclude water shores", () => {
  assert.equal(landEncounterTile(12, 0, 2, 0, 2, false), true);
  assert.equal(landEncounterTile(12, 0, 2, 0, 2, true), false);
  assert.equal(landEncounterTile(12, 0, 2, 2, 0, true), true);
  assert.equal(landEncounterTile(12, 0, 2, 0x14, 2, false), false);
  assert.equal(landEncounterTile(59, 17, 255, 0, 0, false), true);
  assert.equal(landEncounterTile(51, 3, 2, 0, 0, false), false);
});

test("regional encounter guidance targets a reachable grass walking area, preserving disconnected and unknown regions", () => {
  const world = cartridge(false, [
    { id: 2, warps: [[2, 2, 12, 0]] },
    { id: 12, tileset: 0, tile: (_x, y) => y === 3 ? 1 : y > 3 ? 2 : 0, warps: [[2, 1, 2, 0]] },
  ]);
  world.bytes[world.layout.tilesets + 10] = 2; // Verified grass is across an invented impassable separator.
  let guidance = world.graph.encounterGuidance(2, { x: 1, y: 1 }, [12], world.byte, world.layout, world.bytes.length);
  assert.equal(guidance?.here, undefined);
  world.bytes[world.layout.tilesets + 10] = 0; world.graph.reset();
  guidance = world.graph.encounterGuidance(2, { x: 1, y: 1 }, [12], world.byte, world.layout, world.bytes.length);
  assert.equal(guidance?.here, 2); // Includes the landing warp endpoint before the encounter walking area.
  assert.equal(world.graph.encounterGuidance(2, { x: 1, y: 1 }, [], world.byte, world.layout, world.bytes.length), undefined);
  assert.equal(world.graph.encounterGuidance(2, { x: 1, y: 1 }, Array(249).fill(12) as number[], world.byte, world.layout, world.bytes.length), undefined);
});

test("service candidates use the current walking area and do not let four closer disconnected shops hide a reachable fifth shop", () => {
  const world = cartridge(false, [
    { id: 2, tile: (_x, y) => y === 3 ? 1 : 0, warps: [[1, 1, 42, 0], [2, 1, 56, 0], [3, 1, 67, 0], [4, 1, 91, 0], [5, 6, 123, 0]] },
    ...[42, 56, 67, 91, 123].map((id, index) => ({ id, warps: [[3, 7, 2, index === 4 ? 4 : 0] as const] })),
  ]);
  let guidance = world.graph.serviceGuidance("shop", 2, { x: 1, y: 6 }, world.byte, world.layout, world.bytes.length);
  assert.ok(guidance?.here !== undefined); assert.deepEqual(guidance?.candidateMaps, [123]);
  assert.ok(guidance!.exitDistance({ x: 5, y: 6, destination: 123, warp: 4 })! < guidance!.here!);
  guidance = world.graph.serviceGuidance("shop", 2, { x: 1, y: 1 }, world.byte, world.layout, world.bytes.length);
  assert.ok(guidance?.candidateMaps.includes(42)); assert.ok(!guidance?.candidateMaps.includes(123));
  assert.ok(guidance!.candidateMaps.length <= 4, "Each final service query retains at most four targets.");
});

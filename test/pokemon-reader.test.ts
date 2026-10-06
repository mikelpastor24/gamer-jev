import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionContext, GameState } from "../src/core/agent.js";
import type { Emulator, EmulatorAction, EmulatorState, MemoryReader } from "../src/core/emulator.js";
import { controllerActions, validateAgentActions } from "../src/core/actions.js";
import { validateGameState } from "../src/core/game-state.js";
import { GAME_BOY_DESCRIPTOR } from "../src/emulator/game-boy/game-boy-emulator.js";
import { createDefaultGameReaderRegistry } from "../src/profiles/default-registry.js";
import { countBits, decodeBcd, decodeName, readTextScreen } from "../src/profiles/pokemon/encoding.js";
import { GenerationOnePokemonReader } from "../src/profiles/pokemon/generation-one.js";
import { createPokemonRedReader, POKEMON_RED_DESCRIPTOR, POKEMON_RED_LAYOUT } from "../src/profiles/pokemon/red.js";
import { createPokemonBlueReader, POKEMON_BLUE_DESCRIPTOR, POKEMON_BLUE_LAYOUT } from "../src/profiles/pokemon/blue.js";
import { createPokemonYellowReader, POKEMON_YELLOW_DESCRIPTOR, POKEMON_YELLOW_LAYOUT } from "../src/profiles/pokemon/yellow.js";
import { createStateObserver } from "../src/observation/state.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { runAgentHeadless } from "../src/runner/agent-headless.js";
import { RequestBudget } from "../src/providers/requests.js";
import { RED_BLUE_NAVIGATION, YELLOW_NAVIGATION } from "../src/profiles/pokemon/navigation-layout.js";
import { cartridge, forestJourney } from "./fixtures/pokemon-world.js";
import { RED_BLUE_ITEMS, YELLOW_ITEMS } from "../src/profiles/pokemon/item-layout.js";
import { preparationParty, preparationTables } from "./fixtures/pokemon-preparation.js";

const variants = [
  { name: "Red", descriptor: POKEMON_RED_DESCRIPTOR, layout: POKEMON_RED_LAYOUT, create: createPokemonRedReader },
  { name: "Blue", descriptor: POKEMON_BLUE_DESCRIPTOR, layout: POKEMON_BLUE_LAYOUT, create: createPokemonBlueReader },
  { name: "Yellow", descriptor: POKEMON_YELLOW_DESCRIPTOR, layout: POKEMON_YELLOW_LAYOUT, create: createPokemonYellowReader },
];

/** Invented RAM and blank pixels. No ROM bytes, extracted game data, or assets. */
class PokemonMemoryFixture implements Emulator, MemoryReader {
  readonly descriptor = GAME_BOY_DESCRIPTOR;
  readonly rom;
  constructor(readonly variant = variants[0]!) {
    this.rom = { sha256: variant.descriptor.romSha256[0]!, title: "Synthetic memory fixture", byteLength: 0 };
  }
  ram = new Uint8Array(0x10000);
  frameNumber = 0;
  readonly inputs: EmulatorAction[] = [];
  readMemory(address: number, length: number) { return this.ram.slice(address, address + length); }
  captureFrame() { return { number: this.frameNumber, width: 160, height: 144, format: "rgba8888" as const, pixels: new Uint8Array(160 * 144 * 4) }; }
  advance(action: EmulatorAction) { this.inputs.push(structuredClone(action)); this.frameNumber += action.frames; }
  saveState(): EmulatorState { return { schemaVersion: 1, consoleId: "game-boy", backendId: "serverboy", backendVersion: "0.0.7", romSha256: this.rom.sha256, frame: this.frameNumber, payload: Array.from(this.ram) }; }
  restoreState(value: unknown) { const saved = value as EmulatorState; this.frameNumber = saved.frame; this.ram = Uint8Array.from(saved.payload as number[]); }
  reset() { this.ram.fill(0); this.frameNumber = 0; }
  dispose() {}
}

const textBytes = (text: string) => Uint8Array.from([...text].map((character) => character === " " ? 0x7f : character.charCodeAt(0) - 65 + 0x80));
const writeName = (fixture: PokemonMemoryFixture, address: number, name: string) => fixture.ram.set([...textBytes(name), 0x50], address);
function startedFixture(variant = variants[0]!): PokemonMemoryFixture {
  const fixture = new PokemonMemoryFixture(variant);
  const layout = variant.layout;
  fixture.ram[0xff40] = 0x80; fixture.ram[layout.statusFlags6] = 1;
  writeName(fixture, layout.playerName, "TEST"); writeName(fixture, layout.rivalName, "RIVAL");
  fixture.ram[layout.mapId] = 42; fixture.ram[layout.mapWidth] = 5; fixture.ram[layout.mapHeight] = 4;
  fixture.ram[layout.mapX] = 3; fixture.ram[layout.mapY] = 6; fixture.ram[layout.facing] = 12;
  fixture.ram.set([0x12, 0x34, 0x56], layout.money);
  return fixture;
}
function box(fixture: PokemonMemoryFixture, top = 12, bottom = 17) {
  const layout = fixture.variant.layout;
  const tiles = fixture.ram.subarray(layout.tileMap, layout.tileMap + 360);
  tiles.fill(0x7f);
  for (let y = top; y <= bottom; y++) {
    tiles[y * 20] = y === top ? 0x79 : y === bottom ? 0x7d : 0x7c;
    tiles[y * 20 + 19] = y === top ? 0x7b : y === bottom ? 0x7e : 0x7c;
    if (y === top || y === bottom) tiles.fill(0x7a, y * 20 + 1, y * 20 + 19);
  }
  return tiles;
}
function state(fixture: PokemonMemoryFixture): GameState {
  const result = fixture.variant.create().readState(fixture);
  const value = { ...result, source: fixture.variant.descriptor.id, frame: fixture.frameNumber };
  validateGameState(value, fixture.frameNumber); return value;
}
function mon(fixture: PokemonMemoryFixture, address: number, battle = false) {
  fixture.ram[address] = 176; fixture.ram.set([1, 44], address + 1); // HP 300: big endian, not 11265.
  fixture.ram[address + 4] = 8; fixture.ram[address + 5] = 20; fixture.ram[address + 6] = 20;
  fixture.ram.set([33, 45, 0, 0], address + 8);
  fixture.ram[address + (battle ? 14 : 33)] = 50;
  fixture.ram.set([1, 144], address + (battle ? 15 : 34)); // Maximum HP 400.
  fixture.ram.set([0xc5, 20, 0, 0], address + (battle ? 25 : 29));
}

/** Invented cartridge tables and block squares, independent of any commercial map. */
function navigationFixture(variant = variants[0]!, rom = new Uint8Array(7 * 0x4000)) {
  const fixture = startedFixture(variant);
  const navigation = variant.name === "Yellow" ? YELLOW_NAVIGATION : RED_BLUE_NAVIGATION;
  const reads: number[] = [];
  const memory = Object.assign(fixture, { readRom(offset: number, length: number) {
    assert.ok(offset >= 0 && offset + length <= rom.length && length <= 0x4000);
    reads.push(offset); return rom.slice(offset, offset + length);
  } });
  const word = (address: number, value: number) => fixture.ram.set([value & 0xff, value >> 8], address);
  fixture.ram[variant.layout.mapId] = 38;
  fixture.ram[variant.layout.facing] = 4;
  fixture.ram[variant.layout.mapWidth] = 4; fixture.ram[variant.layout.mapHeight] = 4;
  fixture.ram[navigation.bank] = 2; fixture.ram[navigation.tileset] = 1;
  const collisionAddress = variant.name === "Yellow" ? 0x7000 : 0x3000;
  word(navigation.blocks, 0x5000); word(navigation.collision, collisionAddress);
  rom.set([0, 0xff], collisionAddress); rom[navigation.tilePairs] = 0xff; rom[navigation.ledges] = 0xff;
  // Invented automatic-warp list in bank 3; ordinary floor/mat tiles require a directional edge trigger.
  for (let tileset = 0; tileset < 24; tileset++) rom.set([0, 0x60], navigation.warpTiles + tileset * 2);
  rom.set([0x15, 0xff], 3 * 0x4000 + 0x2000);
  fixture.ram.fill(0xff, navigation.counters, navigation.counters + 4);
  fixture.ram[navigation.hiddenList] = 0xff;
  fixture.ram[navigation.warpCount] = 1; fixture.ram.set([1, 7, 1, 37], navigation.warps);
  fixture.ram.fill(255, 0xc6e8, 0xc6e8 + 1300);
  const blockBase = 0x9000; // Blocks in bank 2; Yellow collisions deliberately use bank 1.
  rom.fill(1, blockBase + 255 * 16, blockBase + 256 * 16); // Solid padded border.
  for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) fixture.ram[0xc6e8 + (by + 3) * 10 + bx + 3] = by * 4 + bx;
  const setTile = (x: number, y: number, tile: number) => {
    const block = Math.floor(y / 2) * 4 + Math.floor(x / 2);
    rom[blockBase + block * 16 + ((y & 1) * 2 + 1) * 4 + (x & 1) * 2] = tile;
  };
  setTile(3, 5, 1);
  return { fixture: memory, navigation, rom, reads, setTile };
}

for (const variant of variants) {
  test(`${variant.name} offers capture from a city without balls and keeps the selected purpose through shopping to encounter tiles`, () => {
    const world = cartridge(variant.name === "Yellow", [
      { id: 2, warps: [[2, 2, 56, 0], [4, 2, 12, 0], [6, 2, 58, 0]] },
      { id: 56, warps: [[3, 7, 255, 0]], objects: [{ picture: 38 }] },
      { id: 12, tileset: 0, tile: (x) => x >= 4 ? 2 : 0, warps: [[3, 7, 2, 1]] },
      { id: 58, warps: [[3, 7, 255, 2]], objects: [{ picture: 41 }] },
    ]);
    preparationTables(world.bytes, variant.name === "Yellow"); world.bytes[world.layout.tilesets + 10] = 2;
    const { fixture, navigation, setTile } = navigationFixture(variant, world.bytes);
    fixture.rom.byteLength = world.bytes.length;
    world.bytes.set([0, 2, 255], variant.name === "Yellow" ? 0x7000 : 0x3000);
    preparationParty(fixture.ram, variant.layout); fixture.ram[variant.layout.partyCount] = 1;
    fixture.ram[variant.layout.badges] = 1; fixture.ram.set([0, 0x17, 0x05], variant.layout.money);
    const itemLayout = variant.name === "Yellow" ? YELLOW_ITEMS : RED_BLUE_ITEMS;
    world.bytes.set([0, 2, 0], itemLayout.prices + 9);
    for (const bit of [0, 34, 35, 57, 37]) fixture.ram[navigation.eventFlags + (bit >> 3)]! |= 1 << (bit & 7);
    fixture.ram[variant.layout.mapId] = 2; fixture.ram[navigation.warpCount] = 3;
    fixture.ram.set([2, 2, 0, 56, 2, 4, 0, 12, 2, 6, 0, 58], navigation.warps);
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    let snapshot = provider.read(fixture.captureFrame());
    const catchAction = snapshot.actions.find(action => action.id === "focus_catch")!;
    assert.ok(catchAction); assert.match(catchAction.description, /Priority: attempt every eligible wild species.*Only one.*No capture balls/);
    assert.match(snapshot.actions.find(action => action.id === "focus_heal")!.description, /12\/47 \(26%\)/);
    provider.createExecution!(catchAction).next(); snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.currentFocus, "catch");
    assert.match(snapshot.actions.find(action => action.id === "go_exit_1")!.description, /Matches Jev's persistent catch focus/);
    assert.match(snapshot.state.decisionSupport!.facts.join(" "), /capture purpose currently needs balls/);
    fixture.ram[variant.layout.mapId] = 56; fixture.ram[navigation.lastMap] = 2;
    fixture.ram[navigation.warpCount] = 1; fixture.ram.set([7, 3, 0, 255], navigation.warps);
    fixture.ram[navigation.spriteCount] = 1; fixture.ram[0xc110] = 38;
    fixture.ram[0xc215] = 4; fixture.ram[0xc214] = 9;
    snapshot = provider.read(fixture.captureFrame());
    assert.match(snapshot.actions.find(action => action.id === "interact_object_1")!.description, /Matches Jev's persistent catch focus/);
    fixture.ram[variant.layout.bagCount] = 1; fixture.ram.set([4, 3], variant.layout.bagItems);
    snapshot = provider.read(fixture.captureFrame()); assert.equal(snapshot.state.values.currentFocus, "catch");
    assert.doesNotMatch(snapshot.state.decisionSupport!.facts.join(" "), /capture purpose currently needs balls/);
    assert.match(snapshot.actions.find(action => action.id === "go_exit_1")!.description, /Matches Jev's persistent catch focus/);
    fixture.ram[variant.layout.mapId] = 12; fixture.ram[navigation.lastMap] = 2; fixture.ram[navigation.tileset] = 0;
    fixture.ram[navigation.spriteCount] = 0; fixture.ram[navigation.grass] = 2; fixture.ram.set([7, 3, 1, 2], navigation.warps);
    // Make four nearby invented grass squares passable on both halves of each block.
    const collision = variant.name === "Yellow" ? 0x7000 : 0x3000; world.bytes.set([0, 2, 255], collision);
    for (let x = 4; x < 8; x++) { setTile(x, 5, 2); world.bytes[0x9000 + (2 * 4 + Math.floor(x / 2)) * 16 + 12 + (x & 1) * 2 + 1] = 2; }
    provider.reset!(); snapshot = provider.read(fixture.captureFrame());
    provider.createExecution!(snapshot.actions.find(action => action.id === "focus_catch")!).next(); snapshot = provider.read(fixture.captureFrame());
    assert.ok(snapshot.actions.some(action => action.id.startsWith("walk_grass_")));
    assert.match(snapshot.state.decisionSupport!.facts.join(" "), /Local land encounters.*SPROUT/);
    assert.equal(fixture.inputs.length, 0, "Reading and choosing a purpose cannot send controller input.");
    // Full parties, both regular combat and overworld fields must fit the shared observation contract.
    fixture.ram[variant.layout.partyCount] = 6;
    for (let slot = 1; slot <= 6; slot++) preparationParty(fixture.ram, variant.layout, slot);
    validateGameState(provider.read(fixture.captureFrame()).state, fixture.frameNumber);
    fixture.ram[variant.layout.battleKind] = 1; mon(fixture, variant.layout.battleMon, true); mon(fixture, variant.layout.enemyMon, true);
    validateGameState(provider.read(fixture.captureFrame()).state, fixture.frameNumber);
    assert.ok(provider.read(fixture.captureFrame()).actions.every(action => action.id !== "open_capture_bag"), "Intent does not bypass unverified capture menus.");
  });

  test(`${variant.name} keeps Jev's shop purpose inside the Mart and identifies a milestone trainer from the cartridge`, () => {
    const world = cartridge(variant.name === "Yellow", [
      { id: 2, warps: [[2, 2, 56, 0], [6, 2, 54, 0], [4, 2, 58, 0]] },
      { id: 56, warps: [[3, 7, 255, 0]], objects: [{ picture: 38 }] },
      { id: 54, warps: [[3, 7, 255, 1]], objects: [{ picture: 4, trainer: 201 }] },
      { id: 58, warps: [[3, 7, 255, 2]], objects: [{ picture: 41 }] },
    ]);
    // Invented trainer-class ordering: the label must come from this table, not the class index.
    let name = 14 * 0x4000 + (variant.name === "Yellow" ? 0x197e : 0x19ff);
    for (let i = 0; i < 47; i++) { const text = [...textBytes(i === 0 ? "BROCK" : "SCOUT"), 0x50]; world.bytes.set(text, name); name += text.length; }
    const { fixture, navigation } = navigationFixture(variant, world.bytes);
    fixture.rom.byteLength = world.bytes.length;
    fixture.ram[variant.layout.partyCount] = 1; mon(fixture, variant.layout.partyMons);
    for (const bit of [0, 34, 35, 57, 37]) fixture.ram[navigation.eventFlags + (bit >> 3)]! |= 1 << (bit & 7);
    fixture.ram[variant.layout.mapId] = 2;
    fixture.ram[navigation.warpCount] = 3; fixture.ram.set([2, 2, 0, 56, 2, 6, 0, 54, 2, 4, 0, 58], navigation.warps);
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    let snapshot = provider.read(fixture.captureFrame());
    assert.ok(snapshot.actions.some(action => action.id === "focus_shop"));
    assert.ok(snapshot.actions.every(action => action.id.startsWith("focus_") || action.stop));
    const before = fixture.saveState();
    provider.createExecution!(snapshot.actions.find(action => action.id === "focus_shop")!).next();
    assert.deepEqual(fixture.saveState(), before); // Purpose choice never sends controller input.
    snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.currentFocus, "shop");
    assert.match(snapshot.actions.find(action => action.id === "go_exit_1")!.description, /Matches Jev's persistent shop focus/);
    const previousKey = snapshot.actions.find(action => action.id === "press_down")!.availabilityKey;
    fixture.ram[variant.layout.mapId] = 56; fixture.ram[navigation.lastMap] = 2;
    fixture.ram[navigation.warpCount] = 1; fixture.ram.set([7, 3, 0, 255], navigation.warps);
    fixture.ram[navigation.spriteCount] = 1; fixture.ram[0xc110] = 38;
    fixture.ram[0xc215] = 4; fixture.ram[0xc214] = 9;
    snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.currentFocus, "shop");
    assert.match(snapshot.actions.find(action => action.id === "interact_object_1")!.description, /Shop clerk.*Matches Jev's persistent shop focus/);
    assert.match(snapshot.actions.find(action => action.id === "go_exit_1")!.description, /Does not establish progress.*Leaves the focus destination/);
    assert.ok(snapshot.actions.some(action => action.id === "press_down")); // A legitimate return stays legal.
    provider.createExecution!(snapshot.actions.find(action => action.id === "reconsider_focus")!).next();
    snapshot = provider.read(fixture.captureFrame());
    assert.ok(snapshot.actions.every(action => action.id.startsWith("focus_") || action.stop));
    provider.createExecution!(snapshot.actions.find(action => action.id === "focus_progress")!).next();
    fixture.ram[variant.layout.mapId] = 54; fixture.ram[0xc110] = 4;
    fixture.ram[0xc215] = 8; fixture.ram[0xc214] = 5;
    snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.currentFocus, "progress");
    assert.match(snapshot.actions.find(action => action.id === "interact_object_1")!.description, /Trainer BROCK.*Matches Jev's persistent progress focus.*interaction relates/);
    assert.notEqual(snapshot.actions.find(action => action.id === "press_down")!.availabilityKey, previousKey);
    const exit = snapshot.actions.find(action => action.id === "go_exit_1")!;
    for (let i = 0; i < 6; i++) provider.onActionComplete!({ action: exit,
      record: { actionId: exit.id, fromFrame: 0, toFrame: 604, observation: "fixture", interrupted: false, executionReason: "Map changed." },
      before: snapshot.state, after: snapshot.state });
    snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.currentFocus, "choose");
    assert.match(snapshot.state.decisionSupport!.facts.join(" "), /Six completed actions/);
    assert.match(snapshot.actions.find(action => action.id === "focus_progress")!.description, /Selected 1 time/);
    provider.setObjectives!({ goal: "Inspect this town", constraints: ["Avoid battles"], milestones: [] });
    snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.currentFocus, "choose");
    assert.equal(snapshot.state.values.activeMilestone, undefined);
    provider.reset!(); assert.equal(provider.read(fixture.captureFrame()).state.values.currentFocus, "choose");
    fixture.ram[navigation.grass] = 0;
    snapshot = provider.read(fixture.captureFrame());
    assert.ok(snapshot.actions.some(action => action.id === "focus_train"));
    provider.createExecution!(snapshot.actions.find(action => action.id === "focus_train")!).next();
    snapshot = provider.read(fixture.captureFrame());
    const grass = snapshot.actions.filter(action => action.id.startsWith("walk_grass_"));
    assert.ok(grass.length > 0 && grass.length <= 4);
    assert.match(grass[0]!.description, /Matches Jev's persistent train focus/);
    fixture.ram[variant.layout.partyCount] = 6;
    for (let i = 0; i < 6; i++) mon(fixture, variant.layout.partyMons + i * 44);
    validateGameState(provider.read(fixture.captureFrame()).state, fixture.frameNumber);
    fixture.ram[variant.layout.battleKind] = 1;
    validateGameState(provider.read(fixture.captureFrame()).state, fixture.frameNumber);
    assert.equal(fixture.inputs.length, 0);
  });

  test(`${variant.name} gives Jev regional gate guidance and retains return warnings across battle snapshots`, () => {
    const world = cartridge(variant.name === "Yellow", [
      ...forestJourney.slice(0, -1), { id: 2, warps: [[3, 2, 54, 0]], connections: [[1, 13, 0, 0]] },
      { id: 54, warps: [[3, 7, 255, 0]] },
    ]);
    const { fixture, navigation } = navigationFixture(variant, world.bytes);
    fixture.rom.byteLength = world.bytes.length;
    fixture.ram[variant.layout.mapX] = 4; fixture.ram[variant.layout.mapY] = 5;
    for (const bit of [0, 34, 35, 57, 37]) fixture.ram[navigation.eventFlags + (bit >> 3)]! |= 1 << (bit & 7);
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    const visit = (map: number) => {
      fixture.ram[variant.layout.mapId] = map;
      fixture.ram[navigation.warpCount] = 2;
      fixture.ram.set(map === 50 ? [7, 3, 0, 255, 0, 3, 1, 51] : [6, 3, 0, 50, 1, 3, 0, 47], navigation.warps);
      fixture.ram[navigation.lastMap] = 13;
      return provider.read(fixture.captureFrame());
    };
    visit(13);
    let snapshot = visit(50);
    assert.equal(snapshot.state.values.activeMilestone, "brock");
    assert.match(snapshot.actions.find(action => action.id === "go_exit_2")!.description, /Leads toward.*walking-area/);
    assert.match(snapshot.actions.find(action => action.id === "go_exit_1")!.description, /Leads away from.*Returns to Route 2/);
    assert.match(snapshot.state.decisionSupport!.actionFacts.go_exit_2!.join(" "), /Leads toward/);
    assert.doesNotMatch(snapshot.state.decisionSupport!.actionFacts.go_exit_1!.join(" "), /Leads toward/);
    visit(13); visit(50);
    fixture.ram[variant.layout.battleKind] = 1;
    for (let read = 0; read < 100; read++) provider.read(fixture.captureFrame());
    fixture.ram[variant.layout.battleKind] = 0;
    snapshot = visit(13);
    assert.match(snapshot.state.decisionSupport!.facts.join(" "), /repeated return crossings/);
    assert.match(snapshot.state.decisionSupport!.actionFacts.go_exit_1!.join(" "), /3 immediate return crossings/);
    const controls = snapshot.actions.map(action => action.id);
    assert.ok(controls.includes("go_exit_1")); // Loop evidence cannot remove a legal return trip.
    const before = fixture.saveState();
    provider.read(fixture.captureFrame()); assert.deepEqual(fixture.saveState(), before);
    provider.setObjectives!({ goal: "Inspect this gate", constraints: ["Remain here"], milestones: [] });
    snapshot = visit(50);
    assert.doesNotMatch(snapshot.state.decisionSupport!.facts.join(" "), /repeated return crossings|current walking area/);
    assert.doesNotMatch(snapshot.actions.find(action => action.id === "go_exit_1")!.description, /Leads toward|Leads away|Returns to/);
    provider.reset!();
    assert.doesNotMatch(visit(13).state.decisionSupport!.facts.join(" "), /repeated return crossings/);
    // Adjacent exits with one destination map may land in different regions. Do not guess which one wins.
    const objects = 5 * 0x4000 + 0x1800 + 128; // Invented south-gate object table.
    world.bytes[objects + 1] = 3; world.bytes.set([0, 4, 0, 51], objects + 2 + 8);
    provider.reset!(); provider.setObjectives!(provider.defaultObjectives!);
    fixture.ram[variant.layout.mapId] = 50;
    fixture.ram[navigation.warpCount] = 3;
    fixture.ram.set([7, 3, 0, 255, 0, 3, 1, 51, 0, 4, 0, 51], navigation.warps);
    snapshot = provider.read(fixture.captureFrame());
    assert.match(snapshot.actions.find(action => action.id === "go_exit_2")!.description, /Regional route.*unknown/);
    assert.ok(!snapshot.actions.some(action => action.id === "go_exit_3"));
    assert.equal(fixture.inputs.length, 0);
  });

  test(`${variant.name} verifies the opening story flags, preserves custom goals, and offers a north-exit destination`, () => {
    const { fixture, navigation } = navigationFixture(variant);
    fixture.ram[variant.layout.mapId] = 0;
    fixture.ram[variant.layout.mapX] = 6; fixture.ram[variant.layout.mapY] = 6;
    fixture.ram[navigation.connections] = 8;
    fixture.ram[navigation.connections + 1] = 12;
    const blockBase = 2 * 0x4000 + 0x1000;
    // Invented connected-map padding, so a northward boundary is mechanically reachable.
    fixture.rom.byteLength = 7 * 0x4000;
    const originalRead = fixture.readRom;
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    fixture.readRom = (offset, length) => {
      const bytes = originalRead(offset, length);
      if (offset === 2 * 0x4000) bytes.fill(0, blockBase + 255 * 16 - offset, blockBase + 256 * 16 - offset);
      return bytes;
    };
    let snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.activeMilestone, "meet_oak");
    const route = snapshot.actions.find(action => action.id === "go_boundary_up")!;
    assert.ok(route); assert.equal(route.execution, "profile"); assert.equal(route.frames, 600);
    assert.match(route.description, /Route 1.*Leads toward/);
    assert.match(snapshot.state.decisionSupport!.facts.join("\n"), variant.name === "Yellow" ? /starts on row 0/ : /starts on row 1/);
    fixture.ram[variant.layout.mapId] = 40;
    assert.equal(provider.read(fixture.captureFrame()).state.values.activeMilestone, "meet_oak"); // A visit does not meet Oak.
    for (const [bit, next] of [[0, "starter"], [34, "first_rival"], [35, "collect_parcel"], [57, "deliver_parcel"], [37, "brock"]] as const) {
      fixture.ram[navigation.eventFlags + (bit >> 3)]! |= 1 << (bit & 7);
      snapshot = provider.read(fixture.captureFrame());
      assert.equal(snapshot.state.values.activeMilestone, next);
    }
    provider.setObjectives!({ goal: "Inspect a sign and stay in this town", constraints: ["Stay here"], milestones: [] });
    snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.activeMilestone, undefined);
    assert.equal(snapshot.state.values.starterReceived, true);
    provider.reset?.();
    assert.equal(provider.read(fixture.captureFrame()).state.values.starterReceived, true); // Flags survive local cache reset.
  });

  test(`${variant.name} offers editable defaults and explains a grouped edge exit rather than pacing between its mats`, () => {
    const { fixture, navigation } = navigationFixture(variant);
    fixture.ram[variant.layout.mapId] = 37;
    fixture.ram[variant.layout.mapX] = 2; fixture.ram[variant.layout.mapY] = 7;
    fixture.ram[variant.layout.facing] = 12;
    fixture.ram[navigation.warpCount] = 2; fixture.ram.set([7, 2, 1, 0, 7, 3, 1, 0], navigation.warps);
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    assert.equal(provider.defaultObjectives!.milestones.length, 16);
    assert.match(provider.defaultObjectives!.milestones[0]!, /press toward the outside/);
    assert.match(provider.defaultObjectives!.milestones[1]!, variant.name === "Yellow" ? /receive Pikachu/ : /choose a starter/);
    const copied = provider.defaultObjectives!; (copied.milestones as string[])[0] = "Changed in caller";
    assert.notEqual(provider.defaultObjectives!.milestones[0], "Changed in caller");
    const snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.stepDOWN, "exit_trigger");
    assert.equal(snapshot.state.values.exitTriggerInputs, "press_down");
    assert.match(snapshot.actions.find(action => action.id === "press_down")!.description, /activate the exit to Pallet Town/);
    assert.doesNotMatch(snapshot.actions.find(action => action.id === "press_down")!.description, /map boundary with no connection|only turn; it will not move/);
    assert.match(snapshot.state.decisionSupport!.actionFacts.press_right![0]!, /SAME exit/);
    const exits = snapshot.state.decisionSupport!.facts.filter(fact => fact.startsWith("Exit "));
    assert.equal(exits.length, 1); assert.match(exits[0]!, /\(2,7\)\/\(3,7\).*Activate with press_down/);
    assert.ok(snapshot.actions.some(action => action.id === "press_right")); // A lawful alternative is still Jev's choice.
    fixture.ram[variant.layout.mapX] = 3;
    const other = provider.read(fixture.captureFrame());
    assert.match(other.state.decisionSupport!.facts.join("\n"), /Activate with press_down/);
    assert.match(other.state.decisionSupport!.actionFacts.press_left![0]!, /SAME exit/);
  });

  test(`${variant.name} remembers completed dialogue beyond recent history and protects A from a changed meaning`, () => {
    const fixture = startedFixture(variant);
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    const navigation = variant.name === "Yellow" ? YELLOW_NAVIGATION : RED_BLUE_NAVIGATION;
    const page = (text: string) => { const tiles = box(fixture); tiles.set(textBytes(text), 13 * 20 + 1); fixture.ram[variant.layout.fontLoaded] = 1; };
    const close = () => { fixture.ram.fill(0, variant.layout.tileMap, variant.layout.tileMap + 360); fixture.ram[variant.layout.fontLoaded] = 0; };
    page("MOM");
    const first = provider.read(fixture.captureFrame());
    const key = first.actions.find(action => action.id === "press_a")!.availabilityKey;
    assert.equal(first.state.values.dialogueActive, true);
    const saved = fixture.saveState(); provider.read(fixture.captureFrame()); assert.deepEqual(fixture.saveState(), saved);
    page("MOM IS TALKING");
    assert.equal(provider.read(fixture.captureFrame()).actions.find(action => action.id === "press_a")!.availabilityKey, key);
    for (let index = 0; index < 20; index++) { page(`LINE ${String.fromCharCode(65 + index)}`); provider.read(fixture.captureFrame()); }
    page("OAK IS NEXT DOOR"); provider.read(fixture.captureFrame()); close();
    let snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.completedDialoguesHere, 1);
    assert.equal(snapshot.state.values.lastDialogueStateChanged, false);
    assert.match(String(snapshot.state.values.lastDialogueText), /OAK IS NEXT DOOR/);
    assert.notEqual(snapshot.actions.find(action => action.id === "press_a")!.availabilityKey, key);
    assert.match(snapshot.actions.find(action => action.id === "press_a")!.description, /A starts another interaction/);
    assert.match(snapshot.state.decisionSupport!.facts.join("\n"), /Already completed 1 dialogue/);
    for (let index = 0; index < 10; index++) assert.equal(provider.read(fixture.captureFrame()).state.values.completedDialoguesHere, 1);
    page("MOM");
    snapshot = provider.read(fixture.captureFrame());
    assert.notEqual(snapshot.actions.find(action => action.id === "press_a")!.availabilityKey, key);
    close(); snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.completedDialoguesHere, 2);
    // A quest event after the conversation invalidates the previous no-change warning.
    fixture.ram[navigation.eventFlags + 319] = 1;
    snapshot = provider.read(fixture.captureFrame());
    assert.doesNotMatch(snapshot.state.decisionSupport!.facts.join("\n"), /Already completed/);
    assert.ok(snapshot.actions.some(action => action.id === "press_a"));
    page("GIFT RECEIVED"); provider.read(fixture.captureFrame()); fixture.ram[navigation.eventFlags + 319] = 2;
    close(); snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.lastDialogueStateChanged, true);
    assert.doesNotMatch(snapshot.state.decisionSupport!.facts.join("\n"), /Already completed/);
    provider.reset!(); snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.lastDialogueText, undefined);
    assert.equal(snapshot.state.values.completedDialoguesHere, undefined);
    assert.equal(fixture.inputs.length, 0);
  });

  test(`${variant.name} requires a live bottom dialogue box and does not close conversations at a menu or transition`, () => {
    const fixture = startedFixture(variant);
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    box(fixture); // A stale box without the overworld font is not an active dialogue.
    assert.equal(provider.read(fixture.captureFrame()).state.values.dialogueActive, false);
    fixture.ram.fill(0, variant.layout.tileMap, variant.layout.tileMap + 360);
    assert.equal(provider.read(fixture.captureFrame()).state.values.lastDialogueText, undefined);
    box(fixture, 0, 6); fixture.ram[variant.layout.fontLoaded] = 1;
    assert.equal(provider.read(fixture.captureFrame()).state.values.dialogueActive, false);
    const tiles = box(fixture); tiles.set(textBytes("A REWARD"), 13 * 20 + 1);
    const session = provider.read(fixture.captureFrame()).state.values.dialogueSession;
    tiles[13 * 20 + 1] = 0xed; // A dialogue choice is still part of the conversation.
    assert.equal(provider.read(fixture.captureFrame()).state.values.dialogueSession, session);
    fixture.ram.fill(0, variant.layout.tileMap, variant.layout.tileMap + 360); fixture.ram[0xff40] = 0;
    assert.equal(provider.read(fixture.captureFrame()).state.values.lastDialogueText, undefined);
    fixture.ram[variant.layout.bagCount] = 1; fixture.ram.set([1, 1], variant.layout.bagItems);
    fixture.ram[0xff40] = 0x80; fixture.ram[variant.layout.fontLoaded] = 0;
    const snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.lastDialogueStateChanged, true);
    assert.equal(snapshot.state.values.completedDialoguesHere, 1);
    assert.doesNotMatch(snapshot.state.decisionSupport!.facts.join("\n"), /Already completed/);
  });

  test(`${variant.name} derives collision, exits, and shortest first inputs from live memory and read-only cartridge tables`, () => {
    const { fixture, reads } = navigationFixture(variant);
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    const before = fixture.saveState();
    const snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.stepUP, "blocked");
    assert.equal(snapshot.state.values.stepRIGHT, "walkable");
    assert.equal(snapshot.state.values.locationName, "Player's house, upper floor");
    assert.ok(!snapshot.actions.some(action => action.id === "press_up" || action.id === "press_b" || action.id === "press_select"));
    assert.ok(snapshot.actions.some(action => action.id === "press_start"));
    assert.match(snapshot.state.decisionSupport!.facts.join("\n"), /Exit 1.*\(7,1\).*9 local step.*press_right/);
    assert.match(snapshot.actions.find(action => action.id === "press_right")!.description, /shortest route 9 step/);
    assert.equal(snapshot.state.decisionSupport!.actionFacts.press_up, undefined);
    assert.ok(Object.keys(snapshot.state.decisionSupport!.actionFacts).every(id => snapshot.actions.some(action => action.id === id)));
    assert.deepEqual(fixture.saveState(), before); assert.equal(fixture.inputs.length, 0);
    const count = reads.length; assert.ok(count > 0 && count <= 4);
    provider.read(fixture.captureFrame()); assert.equal(reads.length, count);
    provider.reset!(); provider.read(fixture.captureFrame()); assert.ok(reads.length > count);
  });

  test(`${variant.name} refreshes object occupancy and distinguishes facing, interaction, and hidden objects`, () => {
    const { fixture, navigation, setTile } = navigationFixture(variant);
    setTile(3, 5, 0);
    fixture.ram[navigation.spriteCount] = 1; fixture.ram[0xc110] = 1;
    fixture.ram.set([9, 7], 0xc214); // Object at (3,5), with the engine's four-square padding.
    fixture.ram[variant.layout.facing] = 8;
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    let snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.stepUP, "turn_only");
    assert.match(snapshot.actions.find(action => action.id === "press_up")!.description, /only turn/);
    fixture.ram[variant.layout.facing] = 4;
    snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.stepUP, "blocked");
    assert.ok(!snapshot.actions.some(action => action.id === "press_up"));
    assert.match(snapshot.state.decisionSupport!.actionFacts.press_a!.join("\n"), /Facing Object 1/);
    fixture.ram.set([1, 9, 0xff], navigation.hiddenList); fixture.ram[navigation.hiddenFlags + 1] = 2;
    snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.stepUP, "walkable");
    assert.doesNotMatch(snapshot.state.decisionSupport!.facts.join("\n"), /Object 1/);
  });

  test(variant.name + " identifies visible cartridge pickups without confusing starter sprites or trainers", () => {
    const world = cartridge(variant.name === "Yellow", [{ id: 38, warps: [] }]);
    const { fixture, navigation, setTile } = navigationFixture(variant, world.bytes);
    fixture.rom.byteLength = world.bytes.length;
    const items = variant.name === "Yellow" ? YELLOW_ITEMS : RED_BLUE_ITEMS;
    let names = items.names;
    for (let id = 1; id <= 83; id++) {
      const text = textBytes(id === 21 ? "SUPPLY" : "UNKNOWN");
      world.bytes.set([...text, 0x50], names); names += text.length + 1;
    }
    const objects = 5 * 0x4000 + 0x1800;
    world.bytes.set([0, 3, 61, 9, 7, 0, 0, 0x81, 21, 61, 10, 8, 0, 0, 1,
      1, 11, 9, 0, 0, 0x41, 201, 1], objects + 2);
    setTile(3, 5, 0);
    fixture.ram[navigation.spriteCount] = 3;
    for (let sprite = 1; sprite <= 3; sprite++) {
      fixture.ram[0xc100 + sprite * 16] = sprite === 3 ? 1 : 61;
      fixture.ram.set([8 + sprite, 6 + sprite], 0xc200 + sprite * 16 + 4);
    }
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    let snapshot = provider.read(fixture.captureFrame());
    assert.match(snapshot.actions.find(action => action.id === "interact_object_1")!.description, /pick up Item ball: SUPPLY/);
    assert.match(snapshot.state.decisionSupport!.actionFacts.press_a!.join(" "), /SUPPLY.*subsequent inventory/);
    assert.doesNotMatch(snapshot.actions.find(action => action.id === "interact_object_2")!.description, /pick up|Item ball:/);
    assert.doesNotMatch(snapshot.actions.find(action => action.id === "interact_object_3")!.description, /pick up|Item ball:/);
    fixture.ram[variant.layout.bagCount] = 20;
    fixture.ram.set(Array.from({ length: 20 }, (_, i) => [i + 1, 1]).flat(), variant.layout.bagItems);
    snapshot = provider.read(fixture.captureFrame());
    assert.match(snapshot.actions.find(action => action.id === "interact_object_1")!.description, /No free bag slot/);
    fixture.ram.set([1, 9, 255], navigation.hiddenList); fixture.ram[navigation.hiddenFlags + 1] = 2;
    assert.ok(!provider.read(fixture.captureFrame()).actions.some(action => action.id === "interact_object_1"));
    fixture.ram[navigation.hiddenList] = 255;
    fixture.ram[0xc110] = 2; // Mismatched live sprite must not inherit another object's pickup semantics.
    assert.doesNotMatch(provider.read(fixture.captureFrame()).actions.find(action => action.id === "interact_object_1")!.description, /pick up|Item ball:/);
  });

  test(`${variant.name} waits through real movement and retains unknown surfing and Strength inputs`, () => {
    const { fixture, navigation, setTile } = navigationFixture(variant);
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    fixture.ram[navigation.walkCounter] = 6;
    let snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.movementInProgress, true);
    assert.deepEqual(snapshot.actions.map(action => action.id), ["wait", "stop"]);
    fixture.ram[navigation.walkCounter] = 0; fixture.ram[variant.layout.movementMode] = 2;
    snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.navigationStatus, "partial");
    assert.ok(snapshot.actions.some(action => action.id === "press_up"));
    assert.doesNotMatch(snapshot.state.decisionSupport!.facts.join("\n"), /Shortest first inputs/);
    fixture.ram[variant.layout.movementMode] = 0; fixture.ram[variant.layout.facing] = 4;
    setTile(3, 5, 0); fixture.ram[navigation.spriteCount] = 1;
    fixture.ram[0xc110] = 0x3f; fixture.ram.set([9, 7], 0xc214); fixture.ram[navigation.strengthFlags] = 1;
    snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.stepUP, "unknown");
    assert.ok(snapshot.actions.some(action => action.id === "press_up"));
    assert.match(snapshot.state.decisionSupport!.actionFacts.press_up!.join("\n"), /Strength push/);
  });
}

test("navigation respects tile pairs, one-way ledges, and warp triggers without claiming unknown routes", () => {
  const { fixture, navigation, rom, setTile } = navigationFixture();
  const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
  fixture.ram[navigation.tileset] = 0;
  setTile(3, 6, 2); setTile(4, 6, 3); rom.set([0, 2, 3, 0xff], navigation.tilePairs);
  rom.set([2, 3, 0, 0xff], 0x3000);
  let snapshot = provider.read(fixture.captureFrame());
  assert.equal(snapshot.state.values.stepRIGHT, "turn_only");
  assert.match(snapshot.state.decisionSupport!.actionFacts.press_right!.join("\n"), /tile-pair collision/);
  // An invented one-way ledge permits a two-square downward landing, never the reverse crossing.
  setTile(3, 7, 4); fixture.ram[POKEMON_RED_LAYOUT.mapY] = 5;
  setTile(3, 5, 2); setTile(3, 6, 4); setTile(3, 7, 0);
  rom.set([0, 2, 4, 0x80, 0xff], navigation.ledges); provider.reset!();
  snapshot = provider.read(fixture.captureFrame());
  assert.equal(snapshot.state.values.stepDOWN, "walkable");
  assert.match(snapshot.state.decisionSupport!.actionFacts.press_down!.join("\n"), /one-way ledge jump.*\(3,7\)/);
  setTile(3, 7, 1); provider.reset!();
  snapshot = provider.read(fixture.captureFrame());
  assert.equal(snapshot.state.values.stepDOWN, "turn_only");
  assert.match(snapshot.state.decisionSupport!.actionFacts.press_down!.join("\n"), /ledge landing blocked/);
  fixture.ram.set([5, 3, 1, 37], navigation.warps);
  setTile(3, 4, 1); provider.reset!();
  snapshot = provider.read(fixture.captureFrame());
  assert.equal(snapshot.state.values.stepUP, "unknown");
  assert.ok(snapshot.actions.some(action => action.id === "press_up"));
  assert.match(snapshot.state.decisionSupport!.actionFacts.press_up!.join("\n"), /Standing on an exit/);
});

test("connected edges use the live connection strip, and uninitialized collision tables retain unknown directions", () => {
  const { fixture, navigation, rom } = navigationFixture();
  const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
  fixture.ram[POKEMON_RED_LAYOUT.mapX] = 7; fixture.ram[POKEMON_RED_LAYOUT.mapY] = 3;
  fixture.ram[navigation.connections] = 1; fixture.ram[navigation.connections + 1 + 3 * 11] = 0;
  // An invented passable connected strip at x=8, y=3.
  fixture.ram[0xc6e8 + (1 + 3) * 10 + 4 + 3] = 0;
  let snapshot = provider.read(fixture.captureFrame());
  assert.equal(snapshot.state.values.stepRIGHT, "walkable");
  assert.match(snapshot.state.decisionSupport!.facts.join("\n"), /right boundary to Pallet Town/);
  rom.fill(0, 0x3000, 0x3100); provider.reset!();
  snapshot = provider.read(fixture.captureFrame());
  assert.equal(snapshot.state.values.stepUP, undefined);
  assert.ok(snapshot.actions.some(action => action.id === "press_up"));
  assert.match(snapshot.state.decisionSupport!.facts.join("\n"), /collision table is unavailable/);
});

for (const variant of variants) {
  test(`${variant.name} offers nearby verified loot before purpose selection and reviews healing after a battle in the same health band`, () => {
    const world = cartridge(variant.name === "Yellow", [
      { id: 2, warps: [[6, 2, 58, 0]], objects: [{ picture: 61, item: 21 }] },
      { id: 58, warps: [[3, 7, 255, 0]], objects: [{ picture: 41 }] },
    ]);
    preparationTables(world.bytes, variant.name === "Yellow");
    const { fixture, navigation, setTile } = navigationFixture(variant, world.bytes);
    fixture.rom.byteLength = world.bytes.length; fixture.ram[variant.layout.mapId] = 2;
    fixture.ram.set([2, 6, 0, 58], navigation.warps); setTile(3, 5, 0);
    preparationParty(fixture.ram, variant.layout, 1, 2, 24, 48); fixture.ram[variant.layout.partyCount] = 1;
    for (const bit of [0, 34, 35, 57, 37]) fixture.ram[navigation.eventFlags + (bit >> 3)]! |= 1 << (bit & 7);
    fixture.ram[navigation.spriteCount] = 1; fixture.ram[0xc110] = 61; fixture.ram.set([9, 8], 0xc214);
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    let snapshot = provider.read(fixture.captureFrame());
    assert.ok(snapshot.actions.some(action => action.id === "focus_progress"));
    const loot = snapshot.actions.find(action => action.id === "interact_object_1")!;
    assert.ok(loot, "Nearby loot stays selectable while a purpose is being chosen.");
    assert.match(loot.description, /Priority: collect this nearby verified item/);
    assert.ok(snapshot.state.decisionSupport!.facts.slice(0, 8).some(fact => /Priority: nearby collectible/.test(fact)));
    provider.createExecution!(snapshot.actions.find(action => action.id === "focus_progress")!).next();
    snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.currentFocus, "progress");
    assert.ok(snapshot.actions.some(action => action.id === "focus_heal"), "A direct Jev-selected healing switch remains available.");
    assert.doesNotMatch(snapshot.actions.find(action => action.id === loot.id)!.description, /Does not establish progress/);
    const exitBefore = snapshot.actions.find(action => action.id === "go_exit_1")!;
    fixture.ram[0xc110] = 2;
    const withoutPickup = provider.read(fixture.captureFrame());
    assert.notEqual(withoutPickup.actions.find(action => action.id === exitBefore.id)!.availabilityKey, exitBefore.availabilityKey,
      "A delayed route choice is refreshed when nearby pickup opportunities change.");
    fixture.ram[0xc110] = 61;
    fixture.ram[variant.layout.battleKind] = 2; provider.read(fixture.captureFrame());
    fixture.ram[variant.layout.battleKind] = 0; snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.currentFocus, "choose");
    assert.match(snapshot.actions.find(action => action.id === "focus_heal")!.description, /50%/);
    fixture.ram[variant.layout.bagCount] = 20;
    fixture.ram.set(Array.from({ length: 20 }, (_, i) => [i + 1, 99]).flat(), variant.layout.bagItems);
    snapshot = provider.read(fixture.captureFrame());
    assert.ok(!snapshot.actions.some(action => action.id === loot.id), "Full storage must not advertise this pickup as immediately collectible.");
    fixture.ram.set(Array.from({ length: 20 }, (_, i) => [i + 2, 99]).flat(), variant.layout.bagItems);
    snapshot = provider.read(fixture.captureFrame());
    assert.ok(!snapshot.actions.some(action => action.id === loot.id), "A 99-item existing stack cannot receive another pickup.");
    fixture.ram[variant.layout.bagItems + 39] = 98; snapshot = provider.read(fixture.captureFrame());
    assert.ok(snapshot.actions.some(action => action.id === loot.id), "An existing stack with room remains collectible in a full bag.");
    fixture.ram[variant.layout.bagCount] = 0; fixture.ram[0xc110] = 2;
    snapshot = provider.read(fixture.captureFrame());
    assert.ok(!snapshot.state.decisionSupport!.facts.some(fact => /Priority: nearby collectible/.test(fact)));
    fixture.ram[0xc110] = 61; fixture.ram.set([4, 11], 0xc214);
    fixture.ram[variant.layout.mapX] = 0; fixture.ram[variant.layout.mapY] = 2;
    snapshot = provider.read(fixture.captureFrame());
    assert.ok(snapshot.actions.some(action => action.id === loot.id), "A reachable pickup at eight walking steps is nearby.");
    fixture.ram[variant.layout.mapY] = 3; snapshot = provider.read(fixture.captureFrame());
    assert.ok(!snapshot.actions.some(action => action.id === loot.id), "A nine-step pickup does not bypass the fresh purpose choice.");
    fixture.ram[variant.layout.mapY] = 2; fixture.ram[variant.layout.bagCount] = 21;
    snapshot = provider.read(fixture.captureFrame());
    assert.ok(!snapshot.state.decisionSupport!.facts.some(fact => /Priority: nearby collectible/.test(fact)), "Malformed inventory is not proof that a pickup is storable.");
    assert.equal(fixture.inputs.length, 0, "Reads and focus selection never advance the emulator.");
  });

  test(`${variant.name} exposes explicit step-off choices for an automatic stair landing without selecting a recovery input`, () => {
    const { fixture, navigation, setTile, rom } = navigationFixture(variant);
    fixture.ram[variant.layout.mapX] = 7; fixture.ram[variant.layout.mapY] = 1; setTile(7, 1, 0x15);
    rom.set([0, 0x15, 255], variant.name === "Yellow" ? 0x7000 : 0x3000);
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    let snapshot = provider.read(fixture.captureFrame());
    assert.ok(!snapshot.actions.some(action => action.id === "go_exit_1"), "The zero-distance automatic exit cannot be retriggered in place.");
    const steps = snapshot.actions.filter(action => action.id.startsWith("step_off_exit_"));
    assert.ok(steps.length > 0 && steps.length <= 4); validateAgentActions(snapshot.actions, fixture.descriptor.buttons);
    assert.ok(!steps.some(action => action.id === "step_off_exit_right"), "A step outside the map is not a verified walking square.");
    assert.match(snapshot.state.decisionSupport!.facts.join(" "), /Jev must first choose one available step_off_exit action/);
    const selected = steps.find(action => action.id === "step_off_exit_left")!; assert.ok(selected);
    const execution = provider.createExecution!(selected), first = execution.next();
    assert.equal(first.done, false); if (!first.done) assert.deepEqual(first.buttons, ["LEFT"]);
    assert.equal(fixture.inputs.length, 0, "Execution emits a step; only the runner advances frames.");
    fixture.ram[variant.layout.mapX] = 6;
    assert.equal(execution.next().done, true, "The selected adjacent square ends this action; it never walks back automatically.");
    snapshot = provider.read(fixture.captureFrame());
    assert.ok(snapshot.actions.some(action => action.id === "go_exit_1"));
    assert.ok(!snapshot.actions.some(action => action.id.startsWith("step_off_exit_")));
    fixture.ram[variant.layout.mapX] = 7; rom.set([0, 0], navigation.warpTiles + 2); provider.reset!();
    snapshot = provider.read(fixture.captureFrame());
    assert.ok(snapshot.actions.some(action => action.id === "go_exit_1"), "Unknown warp mechanics retain bounded attempts.");
    assert.ok(!snapshot.actions.some(action => action.id.startsWith("step_off_exit_")));
  });
  test(`${variant.name} does not prioritize returning through an arrival stair when another exit leads closer to healing`, () => {
    const world = cartridge(variant.name === "Yellow", [
      { id: 61, warps: [[3, 3, 60, 0]], tile: (x, y) => x === 3 && y === 3 ? 0x15 : 0 },
      { id: 60, warps: [[3, 3, 61, 0], [6, 6, 58, 0]], tile: (x, y) => x === 3 && y === 3 ? 0x15 : 0 },
      { id: 58, warps: [[3, 7, 255, 1]], objects: [{ picture: 41 }] },
    ]);
    preparationTables(world.bytes, variant.name === "Yellow");
    const { fixture, navigation, setTile } = navigationFixture(variant, world.bytes);
    fixture.rom.byteLength = world.bytes.length; setTile(3, 5, 0); setTile(3, 3, 0x15);
    world.bytes.set([0, 0x15, 255], variant.name === "Yellow" ? 0x7000 : 0x3000);
    fixture.ram[variant.layout.mapId] = 61; fixture.ram[variant.layout.mapX] = 3; fixture.ram[variant.layout.mapY] = 3;
    fixture.ram.set([3, 3, 0, 60], navigation.warps);
    preparationParty(fixture.ram, variant.layout); fixture.ram[variant.layout.partyCount] = 1;
    for (const bit of [0, 34, 35, 57, 37]) fixture.ram[navigation.eventFlags + (bit >> 3)]! |= 1 << (bit & 7);
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    let snapshot = provider.read(fixture.captureFrame());
    provider.createExecution!(snapshot.actions.find(action => action.id === "focus_heal")!).next();
    snapshot = provider.read(fixture.captureFrame());
    assert.ok(snapshot.actions.some(action => action.id.startsWith("step_off_exit_") && /Matches Jev's persistent heal focus/.test(action.description)));
    fixture.ram[variant.layout.mapId] = 60; fixture.ram[navigation.lastMap] = 61;
    fixture.ram[navigation.warpCount] = 2; fixture.ram.set([3, 3, 0, 61, 6, 6, 0, 58], navigation.warps);
    provider.read(fixture.captureFrame()); fixture.frameNumber += 60; snapshot = provider.read(fixture.captureFrame());
    assert.match(snapshot.actions.find(action => action.id === "go_exit_2")!.description, /Matches Jev's persistent heal focus/);
    const steps = snapshot.actions.filter(action => action.id.startsWith("step_off_exit_")); assert.ok(steps.length);
    assert.ok(steps.every(action => !/Matches Jev's persistent heal focus/.test(action.description)));
    assert.ok(steps.every(action => /compare other exits before returning/.test(action.description)));
    assert.equal(snapshot.state.values.currentFocus, "heal", "Crossing a map never silently selects another purpose.");
  });
}

test("edge exit facts cover every facing boundary while special warp rules remain unknown", () => {
  const { fixture, navigation, setTile, rom } = navigationFixture();
  const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
  for (const [x, y, button] of [[0, 3, "left"], [7, 3, "right"], [3, 0, "up"], [3, 7, "down"]] as const) {
    fixture.ram[POKEMON_RED_LAYOUT.mapX] = x; fixture.ram[POKEMON_RED_LAYOUT.mapY] = y;
    fixture.ram.set([y, x, 1, 0], navigation.warps);
    const snapshot = provider.read(fixture.captureFrame());
    assert.equal(snapshot.state.values.exitTriggerInputs, `press_${button}`);
    assert.equal(snapshot.state.values[`step${button.toUpperCase()}`], "exit_trigger");
  }
  for (const mapId of [0x52, 0xc7, 0xc8, 0xca]) {
    fixture.ram[POKEMON_RED_LAYOUT.mapId] = mapId;
    assert.equal(provider.read(fixture.captureFrame()).state.values.exitTriggerInputs, undefined);
  }
  fixture.ram[POKEMON_RED_LAYOUT.mapId] = 37;
  for (const tileset of [0, 13, 14, 23]) {
    fixture.ram[navigation.tileset] = tileset;
    assert.equal(provider.read(fixture.captureFrame()).state.values.exitTriggerInputs, undefined);
  }
  fixture.ram[navigation.tileset] = 1;
  setTile(3, 7, 0x15); provider.reset!();
  assert.equal(provider.read(fixture.captureFrame()).state.values.exitTriggerInputs, undefined); // Automatic staircase warp.
  setTile(3, 7, 0); rom[navigation.warpTiles + 2] = 0; rom[navigation.warpTiles + 3] = 0; provider.reset!();
  assert.equal(provider.read(fixture.captureFrame()).state.values.exitTriggerInputs, undefined); // Uninitialized cartridge table.
});

test("English Gen I decoding handles terminators, endian-independent BCD, and bit padding", () => {
  assert.equal(decodeName(Uint8Array.of(0x80, 0xa1, 0xba, 0xf6, 0x50, 0x99)), "Abé0");
  assert.equal(decodeName(Uint8Array.of(0, 0x50)), undefined);
  assert.equal(decodeName(Uint8Array.of(0x80)), undefined);
  assert.equal(decodeBcd(Uint8Array.of(0x12, 0x34, 0x56)), 123456);
  assert.equal(decodeBcd(Uint8Array.of(0xfa)), undefined);
  const flags = new Uint8Array(19); flags[18] = 0xff;
  assert.equal(countBits(flags, 151), 7);
});

test("boxed memory text provides visible choices without reading graphics as letters", () => {
  const fixture = startedFixture(); const tiles = box(fixture, 0, 5);
  tiles.set(textBytes("NEW GAME"), 2 * 20 + 2); tiles[2 * 20 + 1] = 0xed;
  tiles.set(textBytes("NOT VISIBLE TEXT"), 10 * 20);
  const screen = readTextScreen(tiles);
  assert.equal(screen.top, ">NEW GAME"); assert.equal(screen.bottom, "");
  assert.deepEqual(screen.cursor, { x: 1, y: 2, row: ">NEW GAME" });
  tiles[5 * 20 + 19] = 0;
  assert.equal(readTextScreen(tiles).hasBox, false);
  assert.equal(readTextScreen(new Uint8Array(360).fill(0x80)).top, "");
});

for (const variant of variants) {
  const layout = variant.layout;

  test(`${variant.name} separates intro defaults, menus, exploration, and blocked transitions`, () => {
    const fixture = startedFixture(variant); fixture.ram[layout.statusFlags6] = 0;
    fixture.ram[layout.partyCount] = 3; fixture.ram[layout.badges] = 0xff;
    let snapshot = state(fixture);
    assert.equal(snapshot.values.phase, "boot_or_intro"); assert.equal(snapshot.values.gameStarted, false);
    assert.equal(snapshot.values.mapId, undefined); assert.equal(snapshot.values.partyCount, undefined);
    fixture.ram[layout.statusFlags6] = 1;
    assert.equal(state(fixture).values.phase, "overworld");
    const tiles = box(fixture); tiles.set(textBytes("HELLO"), 14 * 20 + 1);
    assert.equal(state(fixture).values.phase, "text");
    tiles[14 * 20 + 1] = 0xed;
    snapshot = state(fixture); assert.equal(snapshot.values.phase, "menu");
    fixture.ram.fill(0, layout.tileMap, layout.tileMap + 360); fixture.ram[layout.statusFlags5] = 0x20;
    snapshot = state(fixture); assert.equal(snapshot.values.phase, "transition");
    const actions = variant.create().availableActions(snapshot, controllerActions(GAME_BOY_DESCRIPTOR.buttons, 24));
    assert.deepEqual(actions.map((action) => action.id), ["wait", "stop"]);
    fixture.ram[layout.statusFlags5] = 0; fixture.ram[0xff40] = 0;
    assert.equal(state(fixture).values.phase, "transition");
  });

  test(`${variant.name} naming grids expose the prompt and entry while other unboxed graphics stay excluded`, () => {
    const fixture = startedFixture(variant); const tiles = box(fixture, 4, 14);
    tiles.set([...textBytes("YOUR NAME"), 0xe6], 20);
    tiles.set(textBytes("TEST"), 2 * 20 + 10);
    tiles.set(textBytes("A B C D E F G H I"), 5 * 20 + 2); tiles[5 * 20 + 1] = 0xed;
    const snapshot = state(fixture);
    assert.equal(snapshot.values.phase, "naming");
    assert.equal(snapshot.values.namingPrompt, "YOUR NAME?"); assert.equal(snapshot.values.enteredName, "TEST");
    const actions = variant.create().availableActions(snapshot, controllerActions(GAME_BOY_DESCRIPTOR.buttons, 24));
    assert.match(actions.find((action) => action.id === "press_start")!.description, /at least one character/);
    tiles.fill(0x7f, 20, 40);
    tiles.set([...textBytes("RIVAL"), 0xbd, ...textBytes(" NAME"), 0xe6], 20);
    assert.equal(state(fixture).values.namingPrompt, "RIVAL's NAME?");
    tiles[5 * 20 + 2] = 0xa0;
    assert.equal(state(fixture).values.phase, "naming");
    fixture.ram[layout.battleKind] = 1; // A capture can keep the battle flag set during nickname entry.
    assert.equal(state(fixture).values.phase, "naming");
    tiles[5 * 20 + 2] = 0;
    assert.equal(state(fixture).values.enteredName, undefined);
  });

  test(`${variant.name} reports bounded party, money, bag, badge, and Pokédex evidence`, () => {
    const fixture = startedFixture(variant); fixture.ram[layout.partyCount] = 6;
    fixture.ram[layout.bagCount] = 20; fixture.ram[layout.badges] = 5;
    fixture.ram.fill(0xff, layout.pokedexOwned, layout.pokedexOwned + 19);
    for (let slot = 0; slot < 6; slot++) { mon(fixture, layout.partyMons + slot * 44); writeName(fixture, layout.partyNicks + slot * 11, "FRIEND"); }
    for (let slot = 0; slot < 20; slot++) fixture.ram.set([slot + 1, 99], layout.bagItems + slot * 2);
    const before = fixture.ram.slice(); const snapshot = state(fixture);
    assert.equal(snapshot.values.money, 123456); assert.equal(snapshot.values.badges, "Boulder, Thunder");
    assert.equal(snapshot.values.pokedexOwned, 151); assert.equal(snapshot.values.partyCount, 6);
    assert.match(String(snapshot.values.party6), /FRIEND.*speciesId=176.*HP=300\/400.*Fire.*poison/);
    assert.match(String(snapshot.values.party6Moves), /slot1: id=33,PP=5/);
    assert.equal(snapshot.values.mapWidth, 10); assert.equal(snapshot.values.mapHeight, 8);
    assert.equal(snapshot.values.facing, "right"); assert.equal(snapshot.values.battleEnemy, undefined);
    assert.deepEqual(fixture.ram, before); assert.equal(fixture.frameNumber, 0);
    fixture.ram[layout.partyCount] = 7; fixture.ram[layout.bagCount] = 21; fixture.ram[layout.money] = 0xfa;
    const invalid = state(fixture);
    assert.equal(invalid.values.partyCount, "unknown"); assert.equal(invalid.values.party1, undefined);
    assert.equal(invalid.values.bagCount, "unknown"); assert.equal(invalid.values.bagItems, undefined);
    assert.equal(invalid.values.money, "unknown");
  });

  test(`${variant.name} active battle data overrides party HP and disappears when battle ends`, () => {
    const fixture = startedFixture(variant); fixture.ram[layout.partyCount] = 1; mon(fixture, layout.partyMons);
    fixture.ram[layout.battleKind] = 2; mon(fixture, layout.battleMon, true); mon(fixture, layout.enemyMon, true);
    writeName(fixture, layout.battleNick, "FRIEND"); writeName(fixture, layout.enemyNick, "OPPONENT");
    fixture.ram.set([0, 20], layout.battleMon + 1);
    let snapshot = state(fixture);
    assert.equal(snapshot.values.phase, "battle"); assert.equal(snapshot.values.battleKind, "trainer");
    assert.match(String(snapshot.values.party1), /HP=300\/400/);
    assert.match(String(snapshot.values.battlePlayer), /HP=20\/400/);
    assert.match(String(snapshot.values.battlePlayerMoves), /PP=5/);
    fixture.ram[layout.battleKind] = 255;
    snapshot = state(fixture); assert.equal(snapshot.values.battleKind, "lost"); assert.equal(snapshot.values.battleEnemy, undefined);
    fixture.ram[layout.battleKind] = 1; fixture.ram[layout.enemyMon + 14] = 0;
    assert.match(String(state(fixture).values.battleEnemy), /unavailable/);
  });

  test(`${variant.name} actions use single buttons, shorter holds, and stable validated IDs`, () => {
    const fixture = startedFixture(variant); const reader = variant.create();
    const actions = reader.availableActions(state(fixture), controllerActions(GAME_BOY_DESCRIPTOR.buttons, 24));
    validateAgentActions(actions, GAME_BOY_DESCRIPTOR.buttons);
    assert.ok(actions.some((action) => action.id === "press_start"));
    assert.ok(actions.every((action) => action.buttons.length <= 1));
    assert.equal(actions.find((action) => action.id === "press_a")!.frames, 8);
    assert.equal(actions.find((action) => action.id === "wait")!.frames, 24);
    assert.equal(reader.availableActions(state(fixture), controllerActions(["A"], 3))[0]!.frames, 3);
  });

  test(`${variant.name} identifies the START menu and excludes only empty-party confirmation`, () => {
    const fixture = startedFixture(variant); const reader = variant.create();
    const tiles = box(fixture, 0, 14);
    for (const [index, label] of ["POKEMON", "ITEM", "SAVE", "OPTION", "EXIT"].entries()) tiles.set(textBytes(label), (index * 2 + 2) * 20 + 2);
    tiles.fill(0x7f, 2 * 20 + 2, 2 * 20 + 10); tiles.set([0xe1, 0xe2], 2 * 20 + 2); // The actual POKe/MON character codes.
    tiles[2 * 20 + 1] = 0xed;
    const defaults = controllerActions(GAME_BOY_DESCRIPTOR.buttons, 24);
    let snapshot = state(fixture);
    assert.equal(snapshot.values.menuKind, "overworld"); assert.equal(snapshot.values.menuSelection, "POKEMON");
    assert.match(String(snapshot.values.menuSelectionEffect), /party is empty/);
    let actions = reader.availableActions(snapshot, defaults);
    assert.ok(!actions.some((action) => action.id === "press_a"));
    assert.ok(["press_b", "press_down", "press_start", "wait", "stop"].every((id) => actions.some((action) => action.id === id)));
    fixture.ram[layout.partyCount] = 1;
    snapshot = state(fixture);
    assert.equal(snapshot.values.menuSelectionEffect, undefined);
    assert.ok(reader.availableActions(snapshot, defaults).some((action) => action.id === "press_a"));
    fixture.ram[layout.partyCount] = 0; tiles[2 * 20 + 1] = 0x7f; tiles[4 * 20 + 1] = 0xed;
    snapshot = state(fixture); assert.equal(snapshot.values.menuSelection, "ITEM");
    assert.ok(reader.availableActions(snapshot, defaults).some((action) => action.id === "press_a"));
    tiles[4 * 20 + 1] = 0x7f; tiles[2 * 20 + 1] = 0xed;
    tiles.fill(0x7f, 10 * 20 + 1, 10 * 20 + 19); // An incomplete/unrelated menu must not inherit the restriction.
    snapshot = state(fixture); assert.equal(snapshot.values.menuKind, undefined);
    assert.ok(reader.availableActions(snapshot, defaults).some((action) => action.id === "press_a"));
    fixture.ram.fill(0, layout.tileMap, layout.tileMap + 360);
    assert.ok(reader.availableActions(state(fixture), defaults).some((action) => action.id === "press_a"));
    fixture.ram[layout.battleKind] = 1;
    assert.ok(reader.availableActions(state(fixture), defaults).some((action) => action.id === "press_a"));
  });

  test(`the default registry selects only the verified ${variant.name} revision and observes restore and reset`, () => {
    const fixture = startedFixture(variant); const registry = createDefaultGameReaderRegistry();
    const provider = registry.createFor(fixture, 24)!;
    assert.equal(provider.id, variant.descriptor.id);
    const before = provider.read(fixture.captureFrame()); const saved = fixture.saveState();
    fixture.ram[layout.mapX] = 9;
    assert.equal(provider.read(fixture.captureFrame()).state.values.playerX, 9);
    fixture.restoreState(saved); provider.reset?.();
    assert.deepEqual(provider.read(fixture.captureFrame()), before);
    fixture.reset(); provider.reset?.();
    assert.equal(provider.read(fixture.captureFrame()).state.values.gameStarted, false);
    fixture.rom.sha256 = "a".repeat(64);
    assert.equal(registry.createFor(fixture, 24), undefined);
    assert.throws(() => registry.createFor(fixture, 24, variant.descriptor.id), /incompatible/);
    assert.throws(() => new GenerationOnePokemonReader(variant.descriptor, { ...layout, mapX: 0x8000 }), /work RAM/);
  });

  test(`a ${variant.name} memory-only session passes semantic state to decisions and releases bounded inputs`, async () => {
    const fixture = startedFixture(variant); const contexts: DecisionContext[] = [];
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    const limits = new RequestBudget({ maxRequests: 3, timeoutMs: 1000, intervalMs: 0, retries: 0 });
    const session = new AgentSession(fixture, { mode: "mock", visionProvider: "none",
      objectives: { goal: "Inspect the current menu", constraints: [], milestones: [] },
      observer: createStateObserver(provider), budget: limits, actionFrames: 24, maxDecisions: 2, maxSeconds: 60,
      decider: { async decide(context) {
        contexts.push(context);
        return { actionId: "press_a", model: "fixture", confidence: 1, probabilities: {}, usage: { inputTokens: 0, outputTokens: 0 } };
      } },
    });
    try {
      await runAgentHeadless(fixture, session, new AbortController().signal);
      assert.equal(contexts.length, 2); assert.equal(contexts[0]!.gameState!.source, variant.descriptor.id);
      assert.equal(contexts[0]!.gameState!.values.money, 123456);
      assert.ok(contexts[0]!.actions.some((action) => action.id === "press_a" && action.frames === 8));
      assert.equal(fixture.frameNumber, 24); assert.equal(limits.requests, 0);
      assert.ok(fixture.inputs.some((action) => action.buttons.length === 0));
      assert.equal(session.snapshot.completion, "unverified");
    } finally { session.stop("Test finished."); fixture.dispose(); }
  });
}

test("Pokémon profiles reject mismatched versions and do not identify ROMs by title", () => {
  const registry = createDefaultGameReaderRegistry();
  for (const variant of variants) {
    const fixture = startedFixture(variant);
    fixture.rom.title = "POKEMON RED";
    assert.equal(registry.createFor(fixture, 24)!.id, variant.descriptor.id);
    assert.equal(registry.createFor(fixture, 24, variant.descriptor.id)!.id, variant.descriptor.id);
    for (const other of variants.filter((entry) => entry !== variant)) {
      assert.throws(() => registry.createFor(fixture, 24, other.descriptor.id), /incompatible/);
    }
    fixture.rom.sha256 = "0".repeat(64);
    assert.equal(registry.createFor(fixture, 24), undefined);
  }
});

test("Yellow reads its shifted fields while retaining the shared tile-map and facing addresses", () => {
  const fixture = new PokemonMemoryFixture(variants[2]!);
  fixture.ram[0xff40] = 0x80;
  fixture.ram[0xd731] = 1;
  writeName(fixture, 0xd157, "YELLOW");
  fixture.ram.set([0x01, 0x23, 0x45], 0xd346);
  fixture.ram[0xd355] = 2;
  fixture.ram[0xd35d] = 42;
  fixture.ram[0xd360] = 3;
  fixture.ram[0xd361] = 7;
  fixture.ram[0xd367] = 4;
  fixture.ram[0xd368] = 5;
  fixture.ram[0xc109] = 8;
  const tiles = box(fixture);
  tiles.set(textBytes("YELLOW TEXT"), 14 * 20 + 1);
  const result = state(fixture).values;
  assert.equal(result.gameStarted, true);
  assert.equal(result.playerName, "YELLOW");
  assert.equal(result.money, 12345);
  assert.equal(result.badges, "Cascade");
  assert.equal(result.playerX, 7);
  assert.equal(result.playerY, 3);
  assert.equal(result.mapWidth, 10);
  assert.equal(result.mapHeight, 8);
  assert.equal(result.facing, "left");
  assert.equal(result.screenTextBottom, "YELLOW TEXT");
  assert.equal(createPokemonRedReader().readState(fixture).values.gameStarted, false);
});

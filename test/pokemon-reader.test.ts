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

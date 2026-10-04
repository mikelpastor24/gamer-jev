import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionContext, GameState } from "../src/core/agent.js";
import type { Emulator, EmulatorAction, EmulatorState, MemoryReader, RomReader } from "../src/core/emulator.js";
import { controllerActions, validateAgentActions } from "../src/core/actions.js";
import { validateGameState } from "../src/core/game-state.js";
import { GAME_BOY_DESCRIPTOR } from "../src/emulator/game-boy/game-boy-emulator.js";
import { createDefaultGameReaderRegistry } from "../src/profiles/default-registry.js";
import { createPokemonRedReader, POKEMON_RED_DESCRIPTOR, POKEMON_RED_LAYOUT } from "../src/profiles/pokemon/red.js";
import { createPokemonBlueReader, POKEMON_BLUE_DESCRIPTOR, POKEMON_BLUE_LAYOUT } from "../src/profiles/pokemon/blue.js";
import { createPokemonYellowReader, POKEMON_YELLOW_DESCRIPTOR, POKEMON_YELLOW_LAYOUT } from "../src/profiles/pokemon/yellow.js";
import { RED_BLUE_BATTLE, YELLOW_BATTLE } from "../src/profiles/pokemon/battle-layout.js";
import { pokemonMoveExecution, type PokemonMoveExecutionState } from "../src/profiles/pokemon/battle-execution.js";
import { createStateObserver } from "../src/observation/state.js";
import { evaluationRequest } from "../src/jev/evaluation.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { runAgentHeadless } from "../src/runner/agent-headless.js";
import { RequestBudget } from "../src/providers/requests.js";

const variants = [
  { name: "Red", descriptor: POKEMON_RED_DESCRIPTOR, layout: POKEMON_RED_LAYOUT, battle: RED_BLUE_BATTLE, create: createPokemonRedReader },
  { name: "Blue", descriptor: POKEMON_BLUE_DESCRIPTOR, layout: POKEMON_BLUE_LAYOUT, battle: RED_BLUE_BATTLE, create: createPokemonBlueReader },
  { name: "Yellow", descriptor: POKEMON_YELLOW_DESCRIPTOR, layout: POKEMON_YELLOW_LAYOUT, battle: YELLOW_BATTLE, create: createPokemonYellowReader },
];
const encode = (text: string) => Uint8Array.from([...text].map(character => character === " " ? 0x7f : character.charCodeAt(0) - 65 + 0x80));
const names = ["FIREROAR", "WATERJET", "SOFTVOICE", "ODDHIT"];

/** Invented move names, records, pixels and RAM. No commercial assets or API access. */
class BattleFixture implements Emulator, MemoryReader, RomReader {
  readonly descriptor = GAME_BOY_DESCRIPTOR;
  readonly rom;
  readonly romBytes = new Uint8Array(64 * 0x4000);
  readonly romByteLength = this.romBytes.length;
  ram = new Uint8Array(0x10000);
  frameNumber = 0;
  romReads = 0;
  readonly inputs: EmulatorAction[] = [];
  readonly confirmations: number[] = [];
  private previousButton = "";
  constructor(readonly variant = variants[0]!) {
    this.rom = { sha256: variant.descriptor.romSha256[0]!, title: "Synthetic battle", byteLength: this.romByteLength };
    const { layout, battle } = variant;
    this.ram[0xff40] = 0x80; this.ram[layout.statusFlags6] = 1;
    this.ram.set([...encode("PLAYER"), 0x50], layout.playerName);
    this.ram.set([...encode("RIVAL"), 0x50], layout.rivalName);
    this.ram[layout.mapWidth] = 4; this.ram[layout.mapHeight] = 4;
    this.ram[layout.battleKind] = 2;
    this.mon(layout.battleMon); this.mon(layout.enemyMon);
    this.ram.set([1, 2, 3, 4], layout.battleMon + 8);
    this.ram.set([0xc5, 20, 30, 10], layout.battleMon + 25); // PP Up bits do not mean 197 PP.
    let offset = battle.moveNames;
    for (let id = 1; id <= 165; id++) {
      const name = names[id - 1] ?? "UNKNOWN";
      this.romBytes.set([...encode(name), 0x50], offset); offset += name.length + 1;
    }
    this.romBytes.set([1, 0, 70, 20, 255, 15, 2, 0, 40, 21, 229, 25,
      3, 0x12, 0, 0, 255, 40, 4, 0x29, 1, 8, 255, 20], battle.moves);
    // Factual Gen I pairs in a small invented table; unlisted pairs are neutral.
    this.romBytes.set([20, 22, 20, 20, 7, 20, 20, 21, 5, 20, 5, 5, 0, 8, 0,
      8, 24, 0, 3, 7, 20, 7, 3, 20, 0xff], battle.typeEffects);
    this.types(layout.battleMon, 20, 20); this.types(layout.enemyMon, 22, 7);
    this.ram[battle.menuY] = 12; this.ram[battle.menuX] = 5;
    this.ram[battle.menuMax] = 5; this.ram[battle.numMovesMinusOne] = 3; this.ram[battle.watchedKeys] = 0xc7;
    this.ram.fill(0x7f, layout.tileMap, layout.tileMap + 360);
    names.forEach((name, index) => this.ram.set(encode(name), layout.tileMap + (13 + index) * 20 + 6));
    this.select(1);
  }
  mon(address: number, party = false) {
    this.ram[address] = 176; this.ram[address + 2] = 30;
    this.ram[address + (party ? 33 : 14)] = 10; this.ram[address + (party ? 35 : 16)] = 30;
  }
  types(address: number, first: number, second = first) { this.ram[address + 5] = first; this.ram[address + 6] = second; }
  select(slot: number) {
    this.ram[this.variant.battle.menuItem] = slot;
    for (let index = 1; index <= 4; index++) this.ram[this.variant.layout.tileMap + (12 + index) * 20 + 5] = slot === index ? 0xed : 0x7f;
  }
  readMemory(address: number, length: number) { return this.ram.slice(address, address + length); }
  readRom(offset: number, length: number) {
    assert.ok(length <= 0x4000 && offset >= 0 && offset + length <= this.romByteLength);
    this.romReads++; return this.romBytes.slice(offset, offset + length);
  }
  captureFrame() { return { number: this.frameNumber, width: 160, height: 144, format: "rgba8888" as const, pixels: new Uint8Array(160 * 144 * 4) }; }
  advance(action: EmulatorAction) {
    this.inputs.push(structuredClone(action)); this.frameNumber += action.frames;
    const button = action.buttons[0] ?? "", slot = this.ram[this.variant.battle.menuItem]!;
    if (button && button !== this.previousButton) {
      if (button === "DOWN") this.select(slot === 4 ? 1 : slot + 1);
      if (button === "UP") this.select(slot === 1 ? 4 : slot - 1);
      if (button === "A") { this.confirmations.push(slot); this.ram[this.variant.layout.battleMon + 24 + slot]!--; }
    }
    this.previousButton = button;
  }
  saveState(): EmulatorState { return { schemaVersion: 1, consoleId: "game-boy", backendId: "serverboy", backendVersion: "0.0.7", romSha256: this.rom.sha256, frame: this.frameNumber, payload: Array.from(this.ram) }; }
  restoreState(value: unknown) { const saved = value as EmulatorState; this.frameNumber = saved.frame; this.ram = Uint8Array.from(saved.payload as number[]); }
  reset() { this.ram.fill(0); this.frameNumber = 0; }
  dispose() {}
}

function snapshot(fixture: BattleFixture, reader = fixture.variant.create()): GameState {
  const value = { ...reader.readState(fixture), source: reader.descriptor.id, frame: fixture.frameNumber };
  validateGameState(value, fixture.frameNumber); return value;
}
const buttons = controllerActions(GAME_BOY_DESCRIPTOR.buttons, 24);

for (const variant of variants) {
  test(`${variant.name} supplies ROM move metadata, STAB, dual types, and live PP without writes`, () => {
    const fixture = new BattleFixture(variant), reader = variant.create(), before = fixture.ram.slice();
    let state = snapshot(fixture, reader);
    assert.match(String(state.values.battleMove1), /FIREROAR.*Fire.*special.*power=70.*baseAccuracy~100%.*PP=5.*STAB=1.5x.*effectiveness=4x/);
    assert.match(String(state.values.battleMove2), /WATERJET.*Water.*power=40.*baseAccuracy~90%.*STAB=1x/);
    assert.equal(state.values.battleMoveSelection, 1); assert.equal(state.values.battleMenu, "moves");
    fixture.types(variant.layout.enemyMon, 21, 5);
    state = snapshot(fixture, reader); assert.match(String(state.values.battleMove1), /effectiveness=0.25x/);
    fixture.types(variant.layout.enemyMon, 22);
    state = snapshot(fixture, reader); assert.match(String(state.values.battleMove1), /effectiveness=2x/); // One type repeated in RAM, not 4x.
    assert.equal(fixture.frameNumber, 0); fixture.types(variant.layout.enemyMon, 22, 7);
    assert.deepEqual(fixture.ram, before);
    const reads = fixture.romReads; snapshot(fixture, reader); assert.equal(fixture.romReads, reads);
    reader.reset(); snapshot(fixture, reader); assert.ok(fixture.romReads > reads);
  });

  test(`${variant.name} uses Gen I immunities and separates status and special damage from ordinary multipliers`, () => {
    const fixture = new BattleFixture(variant), reader = variant.create();
    fixture.types(variant.layout.enemyMon, 24);
    let state = snapshot(fixture, reader);
    assert.match(String(state.values.battleMove4), /ODDHIT.*special.*damageRule=special.*typeChart=0x/);
    assert.match(String(state.values.battleMove3), /SOFTVOICE.*status.*power=0.*damageRule=status/);
    assert.doesNotMatch(String(state.values.battleMove3), /STAB=|effectiveness=/);
    assert.match(state.decisionSupport!.actionFacts.use_move_3!.join(" "), /do not predict its success.*lowers Attack/);
    assert.match(state.decisionSupport!.actionFacts.use_move_4!.join(" "), /not a damage estimate/);
    fixture.types(variant.layout.enemyMon, 8); fixture.romBytes[variant.battle.moves + 3] = 0; reader.reset();
    state = snapshot(fixture, reader); assert.match(String(state.values.battleMove1), /Normal.*physical.*effectiveness=0x/);
    assert.match(state.decisionSupport!.actionFacts.use_move_1!.join(" "), /immune/);
  });

  test(`${variant.name} offers only usable named slots and guards delayed cursor and PP changes`, () => {
    const fixture = new BattleFixture(variant), reader = variant.create();
    const before = reader.availableActions(snapshot(fixture, reader), buttons);
    validateAgentActions(before, GAME_BOY_DESCRIPTOR.buttons);
    assert.deepEqual(before.filter(action => action.execution).map(action => action.id), ["use_move_1", "use_move_2", "use_move_3", "use_move_4"]);
    const selected = before.find(action => action.id === "use_move_2")!;
    fixture.select(3);
    const moved = reader.availableActions(snapshot(fixture, reader), buttons);
    assert.equal(moved.find(action => action.id === selected.id)!.availabilityKey, selected.availabilityKey);
    assert.notEqual(moved.find(action => action.id === "press_a")!.availabilityKey, before.find(action => action.id === "press_a")!.availabilityKey);
    fixture.ram[variant.layout.battleMon + 27] = 0;
    fixture.ram[variant.battle.disabledMove] = 0x23;
    const limited = reader.availableActions(snapshot(fixture, reader), buttons);
    assert.ok(!limited.some(action => ["use_move_2", "use_move_3", "press_a", "press_select", "press_start", "press_left", "press_right"].includes(action.id)));
    assert.ok(limited.some(action => action.id === "press_b"));
    fixture.select(1);
    assert.notEqual(reader.availableActions(snapshot(fixture, reader), buttons).find(action => action.id === "use_move_1")!.availabilityKey, before.find(action => action.id === "use_move_1")!.availabilityKey);
    fixture.ram[variant.battle.disabledMove] = 0x20; // Disable expired.
    assert.ok(reader.availableActions(snapshot(fixture, reader), buttons).some(action => action.id === "use_move_2"));
  });

  test(`${variant.name} rejects stale/partial menus, unrelated move prompts, and unusual battle variants`, () => {
    const fixture = new BattleFixture(variant), reader = variant.create();
    fixture.ram[variant.battle.menuItem] = 0;
    let state = snapshot(fixture, reader);
    assert.equal(state.values.battleMenu, "moves_pending"); assert.equal(reader.shouldWait(state, 0), true);
    assert.deepEqual(reader.availableActions(state, buttons).map(action => action.id), ["wait", "stop"]);
    fixture.select(1); fixture.ram[variant.layout.tileMap + 13 * 20 + 6] = 0;
    assert.ok(!reader.availableActions(snapshot(fixture, reader), buttons).some(action => action.execution));
    fixture.ram[variant.layout.tileMap + 13 * 20 + 6] = encode("F")[0]!;
    fixture.ram[variant.battle.moveMenuType] = 1;
    assert.ok(!reader.availableActions(snapshot(fixture, reader), buttons).some(action => action.execution));
    fixture.ram[variant.battle.moveMenuType] = 0;
    for (const type of [1, 2]) {
      fixture.ram[variant.layout.battleType] = type;
      state = snapshot(fixture, reader); assert.equal(state.values.battleMove1, undefined);
      assert.ok(!reader.availableActions(state, buttons).some(action => action.execution));
    }
    fixture.ram[variant.layout.battleType] = 0; fixture.ram[variant.layout.enemyMon + 14] = 0;
    assert.ok(!reader.availableActions(snapshot(fixture, reader), buttons).some(action => action.execution));
  });

  test(`${variant.name} keeps invalid cartridge metadata and unknown enemy types unknown`, () => {
    const fixture = new BattleFixture(variant), reader = variant.create();
    fixture.romBytes[variant.battle.typeEffects + 2] = 255;
    let state = snapshot(fixture, reader); assert.match(String(state.values.battleMove1), /effectiveness=unknown/);
    assert.match(state.decisionSupport!.facts.join(" "), /chart is unavailable or invalid/);
    fixture.romBytes[variant.battle.typeEffects + 2] = 20; fixture.types(variant.layout.enemyMon, 99); reader.reset();
    state = snapshot(fixture, reader); assert.match(String(state.values.battleMove1), /effectiveness=unknown/);
    fixture.romBytes[variant.battle.moves + 3] = 99; reader.reset();
    state = snapshot(fixture, reader); assert.match(String(state.values.battleMove1), /moveId=1/);
    assert.doesNotMatch(String(state.values.battleMove1), /Fire|effectiveness/);
    assert.ok(!reader.availableActions(state, buttons).some(action => action.execution));
    const memoryOnly = { readMemory: fixture.readMemory.bind(fixture) };
    const unknown = variant.create().readState(memoryOnly);
    assert.match(String(unknown.values.battleMove1), /moveId=1/);
  });

  test(`${variant.name} stays within state bounds with six party members and retained dialogue evidence`, () => {
    const fixture = new BattleFixture(variant), reader = variant.create();
    fixture.ram[variant.layout.partyCount] = 6;
    for (let slot = 0; slot < 6; slot++) fixture.mon(variant.layout.partyMons + slot * 44, true);
    const originalTiles = fixture.readMemory(variant.layout.tileMap, 360);
    const tiles = fixture.ram.subarray(variant.layout.tileMap, variant.layout.tileMap + 360);
    tiles.fill(0x7f);
    for (let y = 12; y <= 17; y++) {
      tiles[y * 20] = y === 12 ? 0x79 : y === 17 ? 0x7d : 0x7c;
      tiles[y * 20 + 19] = y === 12 ? 0x7b : y === 17 ? 0x7e : 0x7c;
      if (y === 12 || y === 17) tiles.fill(0x7a, y * 20 + 1, y * 20 + 19);
    }
    tiles.set(encode("HELLO"), 13 * 20 + 1);
    fixture.ram[variant.layout.battleKind] = 0; fixture.ram[variant.layout.fontLoaded] = 1;
    snapshot(fixture, reader); // Begin a conversation at this position.
    tiles.fill(0x7f); fixture.ram[variant.layout.fontLoaded] = 0;
    snapshot(fixture, reader); // Return to the overworld and retain its evidence.
    tiles.set(encode("HELLO"), 13 * 20 + 1);
    for (let y = 12; y <= 17; y++) {
      tiles[y * 20] = y === 12 ? 0x79 : y === 17 ? 0x7d : 0x7c;
      tiles[y * 20 + 19] = y === 12 ? 0x7b : y === 17 ? 0x7e : 0x7c;
      if (y === 12 || y === 17) tiles.fill(0x7a, y * 20 + 1, y * 20 + 19);
    }
    fixture.ram[variant.layout.fontLoaded] = 1;
    snapshot(fixture, reader); // Another conversation interrupted by a battle.
    tiles.set(originalTiles); fixture.ram[variant.layout.battleKind] = 2;
    for (let y = 12; y <= 17; y++) {
      tiles[y * 20 + 4] = y === 12 ? 0x79 : y === 17 ? 0x7d : 0x7c;
      tiles[y * 20 + 19] = y === 12 ? 0x7b : y === 17 ? 0x7e : 0x7c;
      if (y === 12 || y === 17) tiles.fill(0x7a, y * 20 + 5, y * 20 + 19);
    }
    const state = snapshot(fixture, reader);
    assert.ok(Object.keys(state.values).length <= 64);
    assert.equal(state.values.party6 !== undefined, true);
    assert.equal(state.values.lastDialogueText, "HELLO");
    assert.equal(state.values.completedDialoguesHere, 1);
    assert.equal(typeof state.values.dialogueSession, "number");
    assert.equal(state.values.menuCursorX, 5);
    validateAgentActions(reader.availableActions(state, buttons), GAME_BOY_DESCRIPTOR.buttons);
  });

  test(`${variant.name} passes matchup choices to the Jev request and executes the chosen second move offline`, async () => {
    const fixture = new BattleFixture(variant), contexts: DecisionContext[] = [];
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    const budget = new RequestBudget({ maxRequests: 1, timeoutMs: 1000, intervalMs: 0, retries: 0 });
    const session = new AgentSession(fixture, { mode: "mock", visionProvider: "none",
      objectives: { goal: "Use the second move", constraints: [], milestones: [] },
      observer: createStateObserver(provider), budget, actionFrames: 24, maxDecisions: 1, maxSeconds: 60,
      decider: { async decide(context) {
        contexts.push(context);
        const request = evaluationRequest(context, "jev-fixture");
        assert.match(request.questions.next_action.criteria.use_move_2!, /WATERJET.*Water.*STAB=1x/);
        assert.match(String(request.state.gameState!.values.battleMove1), /effectiveness=4x/);
        return { actionId: "use_move_2", model: "fixture", confidence: 1, probabilities: {}, usage: { inputTokens: 0, outputTokens: 0 } };
      } },
    });
    try {
      await runAgentHeadless(fixture, session, new AbortController().signal);
      assert.equal(contexts.length, 1); assert.deepEqual(fixture.confirmations, [2]);
      assert.ok(fixture.inputs.some(input => input.buttons[0] === "DOWN"));
      assert.equal(fixture.inputs.at(-1)!.buttons.length, 0); assert.equal(budget.requests, 0);
      assert.ok(fixture.frameNumber < 604);
    } finally { session.stop("Test finished."); }
  });
}

test("move execution tolerates transient printing, cancels changed actors, and cannot silently choose a different slot", () => {
  let state: PokemonMoveExecutionState = { menu: "moves", context: "battle1", selectedSlot: 1, usableSlots: [1, 2, 3] };
  const execution = pokemonMoveExecution(3, () => state, 1);
  assert.deepEqual(execution.next(), { done: false, buttons: ["DOWN"] });
  state = { ...state, menu: "moves_pending", selectedSlot: 0 };
  for (let frame = 0; frame < 5; frame++) assert.deepEqual(execution.next(), { done: false, buttons: [] });
  state = { ...state, menu: "moves", selectedSlot: 2 };
  assert.deepEqual(execution.next(), { done: false, buttons: ["DOWN"] });
  state = { ...state, selectedSlot: 3 };
  for (let frame = 0; frame < 4; frame++) execution.next();
  assert.deepEqual(execution.next(), { done: false, buttons: ["A"] });
  for (let frame = 0; frame < 4; frame++) execution.next();
  assert.equal(execution.next().done, true);
  const stale = pokemonMoveExecution(2, () => state, 8);
  state = { ...state, context: "newEnemy" };
  assert.equal(stale.next().done, true);
  assert.throws(() => pokemonMoveExecution(4, () => state, 8), /no longer available/);
  const changedMove = pokemonMoveExecution(2, () => state, 8);
  state = { ...state, usableSlots: [1, 3] };
  assert.equal(changedMove.next().done, true);
});

test("move execution has a frame ceiling if a cursor remains stuck", () => {
  const execution = pokemonMoveExecution(2, () => ({ menu: "moves", context: "stuck", selectedSlot: 1, usableSlots: [1, 2] }), 8);
  for (let frame = 0; frame < 600; frame++) assert.equal(execution.next().done, false);
  const stopped = execution.next(); assert.equal(stopped.done, true);
  if (stopped.done) assert.match(stopped.reason, /frame ceiling/);
});

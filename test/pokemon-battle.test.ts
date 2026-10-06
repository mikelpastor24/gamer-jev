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
import { pokemonEscapeExecution, pokemonMoveExecution, type PokemonMoveExecutionState } from "../src/profiles/pokemon/battle-execution.js";
import { createStateObserver } from "../src/observation/state.js";
import { evaluationRequest } from "../src/jev/evaluation.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { runAgentHeadless } from "../src/runner/agent-headless.js";
import { RequestBudget } from "../src/providers/requests.js";
import { decodeCharacter } from "../src/profiles/pokemon/encoding.js";
import { withVision } from "../src/observation/combined.js";

const variants = [
  { name: "Red", descriptor: POKEMON_RED_DESCRIPTOR, layout: POKEMON_RED_LAYOUT, battle: RED_BLUE_BATTLE, create: createPokemonRedReader },
  { name: "Blue", descriptor: POKEMON_BLUE_DESCRIPTOR, layout: POKEMON_BLUE_LAYOUT, battle: RED_BLUE_BATTLE, create: createPokemonBlueReader },
  { name: "Yellow", descriptor: POKEMON_YELLOW_DESCRIPTOR, layout: POKEMON_YELLOW_LAYOUT, battle: YELLOW_BATTLE, create: createPokemonYellowReader },
];
const characterCodes = new Map<string, number>();
for (let code = 0; code < 256; code++) {
  const character = decodeCharacter(code);
  if (character?.length === 1) characterCodes.set(character, code);
}
const encode = (text: string) => Uint8Array.from([...text].map(character => {
  const code = characterCodes.get(character);
  assert.notEqual(code, undefined, `Unsupported fixture character: ${character}`); return code!;
}));
const names = ["FIREROAR", "WATERJET", "SOFTVOICE", "ODDHIT"];

test("move cursor pulses end at the selected slot even when each emulator frame repeats the direction", () => {
  let state: PokemonMoveExecutionState = { context: "battle", menu: "moves", selectedSlot: 1, usableSlots: [1, 2, 3, 4] };
  const execution = pokemonMoveExecution(3, () => state, 8), directions: string[] = [], confirmations: number[] = [];
  for (let frame = 0; frame < 100; frame++) {
    const step = execution.next(); if (step.done) break;
    const button = step.buttons[0];
    if (button === "DOWN") { directions.push(button); state = { ...state, selectedSlot: state.selectedSlot === 4 ? 1 : state.selectedSlot + 1 }; }
    if (button === "A") confirmations.push(state.selectedSlot);
  }
  assert.deepEqual(directions, ["DOWN", "DOWN"]); assert.deepEqual(confirmations, [3]);
});

test("an escape action returns from moves and confirms RUN exactly once without retrying or substituting a move", () => {
  let state: PokemonMoveExecutionState = { context: "wild", menu: "moves", selectedSlot: 2, usableSlots: [1, 2], commandX: 9, commandY: 14 };
  const execution = pokemonEscapeExecution(() => state, 1), inputs: string[] = [];
  for (let frame = 0; frame < 100; frame++) {
    const step = execution.next(); if (step.done) break;
    const button = step.buttons[0] ?? ""; if (button) inputs.push(button);
    if (button === "B") state = { ...state, menu: "command" };
    if (button === "RIGHT") state = { ...state, commandX: 15 };
    if (button === "DOWN") state = { ...state, commandY: 16 };
    if (button === "A") state = { ...state, menu: "other" };
  }
  assert.deepEqual(inputs, ["B", "RIGHT", "DOWN", "A"]);
  state = { ...state, menu: "command" }; const cancelled = pokemonEscapeExecution(() => state, 1);
  state = { ...state, context: "another-battle" };
  const next = cancelled.next(); assert.equal(next.done, true);
  if (next.done) assert.match(next.reason, /context changed/);
});

test("opening FIGHT settles locally within a ceiling and never repeats the confirmation when the menu fails to open", () => {
  const state: PokemonMoveExecutionState = { context: "battle", menu: "command", selectedSlot: 0, usableSlots: [1], commandX: 9, commandY: 14 };
  const execution = pokemonMoveExecution(1, () => state, 8); let confirmations = 0, finished = false;
  for (let frame = 0; frame < 130; frame++) {
    const step = execution.next();
    if (step.done) { assert.match(step.reason, /FIGHT menu did not open/); finished = true; break; }
    if (step.buttons.includes("A")) confirmations++;
  }
  assert.equal(confirmations, 1); assert.equal(finished, true);
});

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
  dialogue(lines: readonly string[], arrow = true) {
    const tiles = this.ram.subarray(this.variant.layout.tileMap, this.variant.layout.tileMap + 360);
    tiles.fill(0x7f);
    for (let y = 12; y <= 17; y++) {
      tiles[y * 20] = y === 12 ? 0x79 : y === 17 ? 0x7d : 0x7c;
      tiles[y * 20 + 19] = y === 12 ? 0x7b : y === 17 ? 0x7e : 0x7c;
      if (y === 12 || y === 17) tiles.fill(0x7a, y * 20 + 1, y * 20 + 19);
    }
    lines.forEach((line, index) => tiles.set(encode(line), (14 + index * 2) * 20 + 1));
    if (arrow) tiles[16 * 20 + 18] = 0xee;
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

class FaintingFixture extends BattleFixture {
  acknowledgments = 0;
  constructor(variant = variants[0]!, readonly promptAt = 30) {
    super(variant);
    this.ram[variant.layout.enemyMon + 2] = 0;
    this.dialogue(["Enemy TESTMON", "fain"], false);
  }
  override advance(action: EmulatorAction) {
    this.inputs.push(structuredClone(action)); this.frameNumber += action.frames;
    if (action.buttons.includes("A")) {
      this.acknowledgments++;
      this.dialogue(["Use next POKEMON?", "YES NO"], false);
      this.ram[this.variant.layout.tileMap + 16 * 20 + 1] = 0xed;
    } else if (this.frameNumber >= this.promptAt && !this.acknowledgments) this.dialogue(["Enemy TESTMON", "fainted!"]);
  }
}

class PrintingFixture extends BattleFixture {
  acknowledgments = 0;
  constructor(variant = variants[0]!, readonly promptAt = 20) {
    super(variant); this.dialogue(["Enemy TESTMON", "used TESTMOVE"], false);
  }
  override advance(action: EmulatorAction) {
    this.inputs.push(structuredClone(action)); this.frameNumber += action.frames;
    if (action.buttons.includes("A")) { this.acknowledgments++; this.ram.fill(0x7f, this.variant.layout.tileMap, this.variant.layout.tileMap + 360); }
    else if (this.frameNumber >= this.promptAt && !this.acknowledgments) this.dialogue(["Enemy TESTMON", "used TESTMOVE!"]);
  }
}

function snapshot(fixture: BattleFixture, reader = fixture.variant.create()): GameState {
  const value = { ...reader.readState(fixture), source: reader.descriptor.id, frame: fixture.frameNumber };
  validateGameState(value, fixture.frameNumber); return value;
}
const buttons = controllerActions(GAME_BOY_DESCRIPTOR.buttons, 24);

for (const variant of variants) {
  test(`${variant.name} retains text settling and prompt identity while the active battle actor is initializing`, () => {
    const fixture = new PrintingFixture(variant), reader = variant.create(); fixture.ram[variant.layout.battleMon + 14] = 0;
    let state = snapshot(fixture, reader); assert.equal(state.values.battleMenu, "text_pending");
    assert.equal(reader.shouldWait(state, 0), true);
    assert.ok(!reader.availableActions(state, buttons).some(action => action.execution));
    fixture.ram.fill(0x7f, variant.layout.tileMap, variant.layout.tileMap + 360);
    state = snapshot(fixture, reader); assert.equal(state.values.battleMenu, "actors_pending");
    assert.equal(reader.shouldWait(state, 0), true);
    fixture.dialogue(["Enemy TESTMON", "entered battle!"]);
    state = snapshot(fixture, reader); assert.equal(state.values.battleMenu, "text_acknowledgment");
    const before = reader.availableActions(state, buttons).find(action => action.id === "press_a")!;
    fixture.dialogue(["Different message"]); state = snapshot(fixture, reader);
    const after = reader.availableActions(state, buttons).find(action => action.id === "press_a")!;
    assert.notEqual(before.availabilityKey, after.availabilityKey);
    assert.match(state.decisionSupport!.decisionGoal!, /Actor data are still initializing/);
  });

  test(`${variant.name} settles ordinary battle text without model calls until Jev can select its acknowledgment`, async () => {
    const fixture = new PrintingFixture(variant);
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 8)!;
    let visionCalls = 0, decisions = 0;
    const observer = withVision(createStateObserver(provider), { async observe() {
      visionCalls++; assert.ok(fixture.frameNumber >= 20);
      return { text: "Completed fixture message", model: "fixture", usage: { inputTokens: 0, outputTokens: 0 } };
    } });
    const session = new AgentSession(fixture, { mode: "mock", visionProvider: "mock", observer,
      objectives: { goal: "Acknowledge the completed message", constraints: [], milestones: [] },
      budget: new RequestBudget({ maxRequests: 1, timeoutMs: 1000, intervalMs: 0, retries: 0 }), actionFrames: 8, maxDecisions: 1, maxSeconds: 60,
      decider: { async decide(context) {
        decisions++; assert.equal(context.gameState!.values.battleMenu, "text_acknowledgment");
        assert.deepEqual(context.actions.map(action => action.id), ["press_a", "press_b", "stop"]);
        return { actionId: "press_a", confidence: 1, model: "fixture", probabilities: {}, usage: { inputTokens: 0, outputTokens: 0 } };
      } },
    });
    try {
      const initial = provider.read(fixture.captureFrame()); assert.equal(initial.state.values.battleMenu, "text_pending");
      session.tick(10); session.tick(10); assert.equal(decisions, 0); assert.equal(visionCalls, 0);
      assert.ok(fixture.inputs.every(input => input.buttons.length === 0));
      await runAgentHeadless(fixture, session, new AbortController().signal);
      assert.equal(decisions, 1); assert.equal(visionCalls, 1); assert.equal(fixture.acknowledgments, 1);
    } finally { session.stop("Fixture finished."); fixture.dispose(); }
  });

  test(`${variant.name} skips Jev and vision during fainting, then executes only one Jev-selected acknowledgment`, async () => {
    const fixture = new FaintingFixture(variant), contexts: DecisionContext[] = [];
    const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
    let visionCalls = 0;
    const observer = withVision(createStateObserver(provider), { async observe() {
      visionCalls++; assert.ok(fixture.frameNumber >= 30);
      return { text: "Synthetic fainted message", model: "fixture", usage: { inputTokens: 0, outputTokens: 0 } };
    } });
    const budget = new RequestBudget({ maxRequests: 1, timeoutMs: 1000, intervalMs: 0, retries: 0 });
    const session = new AgentSession(fixture, { mode: "mock", visionProvider: "mock", observer, budget,
      objectives: { goal: "Acknowledge the fainted message", constraints: [], milestones: [] }, actionFrames: 24, maxDecisions: 1, maxSeconds: 60,
      decider: { async decide(context) {
        contexts.push(context); assert.equal(context.gameState!.values.battleMenu, "text_acknowledgment");
        assert.deepEqual(context.actions.map(action => action.id), ["press_a", "press_b", "stop"]);
        const request = evaluationRequest(context, "fixture");
        assert.match(request.questions.next_action.criteria.press_a!, /advances the current battle message once/);
        return { actionId: "press_a", confidence: 1, model: "fixture", probabilities: {}, usage: { inputTokens: 0, outputTokens: 0 } };
      } },
    });
    try {
      session.tick(10); session.tick(10); session.tick(10);
      assert.equal(fixture.frameNumber, 30); assert.equal(contexts.length, 0); assert.equal(visionCalls, 0);
      assert.ok(fixture.inputs.every(input => input.buttons.length === 0));
      await runAgentHeadless(fixture, session, new AbortController().signal);
      assert.equal(contexts.length, 1); assert.equal(visionCalls, 1); assert.equal(budget.requests, 0);
      assert.equal(fixture.acknowledgments, 1);
      assert.deepEqual(fixture.inputs.filter(input => input.buttons.length), [{ buttons: ["A"], frames: 1 }]);
      assert.equal(fixture.inputs.at(-1)!.buttons.length, 0);
      assert.equal(provider.read(fixture.captureFrame()).state.values.battleMenu, "other"); // The next choice was not answered.
    } finally { session.stop("Test finished."); }
  });

  test(`${variant.name} explains fainted text prompts, excludes ineffective waiting, and keeps blinking input meaning stable`, () => {
    const fixture = new BattleFixture(variant), reader = variant.create();
    fixture.ram[variant.layout.enemyMon + 2] = 0;
    fixture.dialogue(["Enemy TESTMON", "fainted!"]);
    const before = fixture.ram.slice();
    let state = snapshot(fixture, reader), offered = reader.availableActions(state, buttons);
    assert.equal(state.values.battleMenu, "text_acknowledgment");
    assert.equal(reader.shouldWait(state, fixture.frameNumber), false);
    assert.deepEqual(offered.map(action => action.id), ["press_a", "press_b", "stop"]);
    assert.match(state.decisionSupport!.facts.join(" "), /waiting for A or B, not more time.*enemy has 0 HP/);
    assert.match(offered.find(action => action.id === "press_a")!.description, /advances the current battle message once/);
    assert.equal(offered.find(action => action.id === "press_a")!.frames, 1);
    validateAgentActions(offered, GAME_BOY_DESCRIPTOR.buttons);
    assert.deepEqual(fixture.ram, before); assert.equal(fixture.frameNumber, 0);
    const key = offered.find(action => action.id === "press_a")!.availabilityKey;
    fixture.ram[variant.layout.tileMap + 16 * 20 + 18] = 0x7f;
    state = snapshot(fixture, reader); offered = reader.availableActions(state, buttons);
    assert.equal(state.values.battleMenu, "text_acknowledgment");
    assert.equal(offered.find(action => action.id === "press_a")!.availabilityKey, key);
    fixture.dialogue(["TESTMON gained", "12 EXP. Points!"]);
    assert.notEqual(reader.availableActions(snapshot(fixture, reader), buttons).find(action => action.id === "press_a")!.availabilityKey, key);
    fixture.ram[variant.layout.tileMap + 16 * 20 + 18] = 0x7f;
    reader.reset(); state = snapshot(fixture, reader);
    assert.equal(state.values.battleMenu, "faint_pending"); assert.equal(reader.shouldWait(state, 0), true);
  });

  test(`${variant.name} settles fainting without hiding party, YES/NO, naming or unknown choices`, () => {
    const fixture = new BattleFixture(variant), reader = variant.create();
    fixture.ram[variant.layout.battleMon + 2] = 0;
    fixture.dialogue(["TESTMON", "fain"], false);
    let state = snapshot(fixture, reader);
    assert.equal(state.values.battleMenu, "faint_pending"); assert.equal(reader.shouldWait(state, 0), true);
    assert.match(state.decisionSupport!.facts.join(" "), /active Pokemon has 0 HP and cannot attack/);
    fixture.dialogue(["Use next POKEMON?", "YES NO"], false);
    fixture.ram[variant.layout.tileMap + 16 * 20 + 1] = 0xed;
    state = snapshot(fixture, reader);
    assert.equal(state.values.battleMenu, "other"); assert.equal(reader.shouldWait(state, 0), false);
    assert.ok(reader.availableActions(state, buttons).some(action => action.id === "press_down"));
    assert.match(state.decisionSupport!.facts.join(" "), /choice screen, not a neutral animation/);
    fixture.dialogue(["Choose a POKEMON", "TESTMON"], true);
    fixture.ram[variant.layout.tileMap + 16 * 20 + 1] = 0xec;
    state = snapshot(fixture, reader); assert.equal(state.values.battleMenu, "other");
    assert.equal(reader.shouldWait(state, 0), false); // Hollow party cursor: never auto-confirm a replacement.
    fixture.dialogue(["A B C D E F G H I", "J K L M N O P Q R"], true);
    state = snapshot(fixture, reader); assert.notEqual(state.values.battleMenu, "text_acknowledgment");
    assert.equal(reader.shouldWait(state, 0), false);
    fixture.ram[variant.layout.battleType] = 1;
    fixture.dialogue(["TESTMON", "fainted!"]);
    state = snapshot(fixture, reader); assert.equal(state.values.battleMenu, undefined);
    assert.ok(reader.availableActions(state, buttons).some(action => action.id === "wait"));
  });

  test(`${variant.name} does not mistake stale move names with a fainted actor for printing`, () => {
    const fixture = new BattleFixture(variant), reader = variant.create();
    fixture.ram[variant.layout.enemyMon + 2] = 0;
    const state = snapshot(fixture, reader);
    assert.equal(state.values.battleMenu, "other"); assert.equal(reader.shouldWait(state, 0), false);
    assert.ok(!reader.availableActions(state, buttons).some(action => action.id.startsWith("use_move_")));
  });

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

  test(`${variant.name} prevents exhausted stat effects and known ordinary immunity while preserving unknown and fallback attempts`, () => {
    const fixture = new BattleFixture(variant), reader = variant.create();
    fixture.ram.fill(7, variant.battle.playerStages, variant.battle.playerStages + 6);
    fixture.ram.fill(7, variant.battle.enemyStages, variant.battle.enemyStages + 6); fixture.select(3);
    let state = snapshot(fixture, reader), actions = reader.availableActions(state, buttons);
    const previous = actions.find(action => action.id === "use_move_3")!;
    assert.match(state.decisionSupport!.actionFacts.use_move_3!.join(" "), /Enemy Attack stage=\+0/);
    fixture.ram[variant.battle.enemyStages] = 1; state = snapshot(fixture, reader); actions = reader.availableActions(state, buttons);
    assert.match(String(state.values.battleMove3), /NO EFFECT.*minimum -6/);
    assert.ok(!actions.some(action => ["use_move_3", "press_a"].includes(action.id)));
    assert.ok(actions.some(action => action.id === "use_move_1")); assert.ok(actions.some(action => action.id === "press_b"));
    assert.throws(() => reader.createExecution(fixture, previous), /no longer available/);
    fixture.ram[variant.battle.enemyStages] = 0; state = snapshot(fixture, reader);
    assert.ok(reader.availableActions(state, buttons).some(action => action.id === "use_move_3"), "Unknown stages never prove exhaustion.");
    fixture.ram[variant.battle.enemyStages] = 1; fixture.ram[variant.layout.battleMon + 25] = 0;
    fixture.ram[variant.layout.battleMon + 26] = 0; fixture.ram[variant.layout.battleMon + 28] = 0;
    state = snapshot(fixture, reader); assert.ok(reader.availableActions(state, buttons).some(action => action.id === "use_move_3"), "With no decoded alternative, the failed move stays an explicit bounded attempt.");
    fixture.ram[variant.layout.battleMon + 25] = 5; fixture.romBytes[variant.battle.moves + 3] = 0;
    fixture.types(variant.layout.enemyMon, 8); reader.reset(); fixture.select(1); state = snapshot(fixture, reader);
    assert.ok(reader.availableActions(state, buttons).some(action => action.id === "use_move_1"), "An immune move remains when every other usable move is known ineffective.");
    fixture.ram[variant.layout.battleMon + 26] = 20; state = snapshot(fixture, reader);
    assert.ok(!reader.availableActions(state, buttons).some(action => ["use_move_1", "press_a"].includes(action.id)));
    assert.ok(reader.availableActions(state, buttons).some(action => action.id === "use_move_2"));
  });

  test(`${variant.name} offers a chosen move from the verified command screen and executes only that slot after opening FIGHT`, () => {
    const fixture = new BattleFixture(variant), reader = variant.create(), moveTiles = fixture.readMemory(variant.layout.tileMap, 360);
    fixture.ram[variant.layout.battleKind] = 1; fixture.dialogue([], false);
    const tiles = fixture.ram.subarray(variant.layout.tileMap, variant.layout.tileMap + 360);
    tiles.set(encode("FIGHT"), 14 * 20 + 10); tiles.set(encode("ITEM"), 16 * 20 + 10);
    tiles.set(encode("PKM"), 14 * 20 + 16); tiles.set(encode("RUN"), 16 * 20 + 16); tiles[14 * 20 + 9] = 0xed;
    const state = snapshot(fixture, reader); assert.equal(state.values.battleMenu, "command");
    const actions = reader.availableActions(state, buttons); validateAgentActions(actions, fixture.descriptor.buttons);
    assert.ok(actions.some(action => action.id === "run_from_wild"));
    assert.match(state.decisionSupport!.decisionGoal!, /Capture is currently unavailable/);
    const chosen = actions.find(action => action.id === "use_move_2")!; assert.ok(chosen);
    const execution = reader.createExecution(fixture, chosen);
    assert.deepEqual(execution.next(), { done: false, buttons: ["A"] }, "Only FIGHT is opened; no attack has been confirmed yet.");
    assert.equal(fixture.confirmations.length, 0);
    fixture.ram.set(moveTiles, variant.layout.tileMap); fixture.select(1);
    for (let frame = 0; frame < 100; frame++) {
      const step = execution.next(); if (step.done) break;
      fixture.advance({ buttons: step.buttons, frames: 1 });
    }
    assert.deepEqual(fixture.confirmations, [2]);
    fixture.ram[variant.layout.battleKind] = 2;
    assert.ok(!reader.availableActions(snapshot(fixture, reader), buttons).some(action => action.id === "run_from_wild"));
  });

  test(`${variant.name} rejects stale/partial menus, unrelated move prompts, and unusual battle variants`, () => {
    const fixture = new BattleFixture(variant), reader = variant.create();
    fixture.ram[variant.battle.menuItem] = 0;
    let state = snapshot(fixture, reader);
    assert.equal(state.values.battleMenu, "moves_pending"); assert.equal(reader.shouldWait(state, 0), true);
    assert.deepEqual(reader.availableActions(state, buttons).map(action => action.id), ["wait", "stop"]);
    fixture.select(1); fixture.ram[variant.layout.tileMap + 13 * 20 + 6] = 0;
    state = snapshot(fixture, reader);
    assert.equal(state.values.battleMenu, "moves_pending", "A partially printed verified move list settles instead of confirming its old highlight.");
    assert.ok(!reader.availableActions(state, buttons).some(action => action.execution || action.id === "press_a"));
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

test("unknown fainting readiness is frame-bounded and cancelling settling sends no input or provider requests", async () => {
  const fixture = new FaintingFixture(variants[0], Infinity);
  const provider = createDefaultGameReaderRegistry().createFor(fixture, 24)!;
  let calls = 0;
  const session = new AgentSession(fixture, { mode: "mock", visionProvider: "none", observer: createStateObserver(provider),
    budget: new RequestBudget({ maxRequests: 1, timeoutMs: 1000, intervalMs: 0, retries: 0 }),
    objectives: { goal: "Inspect unknown fainting", constraints: [], milestones: [] }, actionFrames: 24, maxDecisions: 1, maxSeconds: 60,
    decider: { async decide(context) {
      calls++; assert.equal(context.frame, 700); assert.equal(context.gameState!.values.battleMenu, "faint_pending");
      assert.ok(context.actions.some(action => action.id === "press_a")); // Unknown readiness retains attempts after the ceiling.
      return { actionId: "stop", confidence: 1, model: "fixture", probabilities: {}, usage: { inputTokens: 0, outputTokens: 0 } };
    } },
  });
  try {
    session.tick(100); session.pause(); session.tick(600);
    assert.equal(fixture.frameNumber, 100); assert.equal(calls, 0);
    session.resume(); session.tick(600);
    assert.equal(fixture.frameNumber, 700); assert.equal(calls, 0);
    await runAgentHeadless(fixture, session, new AbortController().signal);
    assert.equal(calls, 1); assert.ok(fixture.inputs.every(input => input.buttons.length === 0));
  } finally { session.stop("Test finished."); }
});

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

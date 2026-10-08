import assert from "node:assert/strict";
import { test } from "node:test";
import { controllerActions, validateAgentActions } from "../src/core/actions.js";
import { validateGameState } from "../src/core/game-state.js";
import { GAME_BOY_DESCRIPTOR } from "../src/emulator/game-boy/game-boy-emulator.js";
import { PokemonTeamFixture, teamVariants, encodeTeamText } from "./fixtures/pokemon-team.js";
import { pokemonNamingExecution, type PokemonNamingState } from "../src/profiles/pokemon/naming-execution.js";
import { pokemonItemExecution, type PokemonItemExecutionState } from "../src/profiles/pokemon/item-execution.js";
import { medicineBenefit, pokemonPartyMembers } from "../src/profiles/pokemon/medicine.js";
import { evaluationRequest } from "../src/jev/evaluation.js";
import type { Emulator, MemoryReader, RomReader } from "../src/core/emulator.js";
import { createDefaultGameReaderRegistry } from "../src/profiles/default-registry.js";
import { createStateObserver } from "../src/observation/state.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { runAgentHeadless } from "../src/runner/agent-headless.js";
import { RequestBudget } from "../src/providers/requests.js";
import { pokemonPartyMenuExecution, type PokemonMoveExecutionState } from "../src/profiles/pokemon/battle-execution.js";

const buttons = controllerActions(GAME_BOY_DESCRIPTOR.buttons, 24);
function snapshot(fixture: PokemonTeamFixture, reader: ReturnType<typeof teamVariants[number]["create"]>) {
  const state = { ...reader.readState(fixture), source: reader.descriptor.id, frame: 0 };
  const actions = reader.availableActions(state, buttons);
  validateGameState(state, 0); validateAgentActions(actions, GAME_BOY_DESCRIPTOR.buttons);
  return { state, actions };
}
function execute(fixture: PokemonTeamFixture, reader: ReturnType<typeof teamVariants[number]["create"]>, id: string) {
  const action = snapshot(fixture, reader).actions.find(candidate => candidate.id === id); assert.ok(action, `Expected ${id}`);
  const execution = reader.createExecution(fixture, action);
  for (let frame = 0; frame <= 600; frame++) {
    const step = execution.next(); if (step.done) return step.reason;
    fixture.step(step.buttons[0] ?? "");
  }
  assert.fail("Selected execution must stay bounded.");
}

function fixtureEmulator(fixture: PokemonTeamFixture): Emulator & MemoryReader & RomReader {
  let frame = 0;
  return {
    descriptor: GAME_BOY_DESCRIPTOR,
    rom: { sha256: fixture.variant.create().descriptor.romSha256[0]!, title: "Invented team menus", byteLength: fixture.romByteLength },
    get frameNumber() { return frame; },
    readMemory: fixture.readMemory.bind(fixture), readRom: fixture.readRom.bind(fixture),
    captureFrame() { return { number: frame, width: 160, height: 144, format: "rgba8888", pixels: new Uint8Array(160 * 144 * 4) }; },
    advance(action) { frame += action.frames; fixture.advance(action); },
    saveState() { throw Error("Unexpected checkpoint write"); }, restoreState() { throw Error("Unexpected restore"); },
    reset() { throw Error("Unexpected reset"); }, dispose() {},
  };
}

for (const variant of teamVariants) {
  test(variant.name + " opens POKEMON without choosing a member or confirming SWITCH automatically", () => {
    const fixture = new PokemonTeamFixture(variant), reader = variant.create();
    assert.match(execute(fixture, reader, "open_party_menu"), /party menu opened/);
    assert.equal(snapshot(fixture, reader).state.values.partyMenuKind, "switch");
    assert.equal(fixture.ram[variant.menu.playerPartyIndex], 0); assert.equal(fixture.confirmations, 0);
    assert.equal(fixture.inputs.filter(input => input === "A").length, 1);
    fixture.hp(1, 0); fixture.command();
    assert.ok(!snapshot(fixture, reader).actions.some(action => action.id === "open_party_menu"));
  });
  test(variant.name + " types exactly a unique whole name from objectives, replacing repeated letters without advancing during reads", () => {
    const fixture = new PokemonTeamFixture(variant), reader = variant.create();
    fixture.naming("AAAAAAAAAA");
    reader.setObjectives({ goal: "Prepare the party", constraints: [], milestones: ["Pokemon names: TWIN, WING, BUDDY"] });
    const before = fixture.ram.slice(), current = snapshot(fixture, reader);
    assert.deepEqual(fixture.ram, before); assert.equal(current.state.values.phase, "naming");
    assert.equal(current.state.values.namingKind, "pokemon"); assert.equal(current.state.values.enteredName, "AAAAAAAAAA");
    const names = current.actions.filter(action => action.id.startsWith("name_option_"));
    assert.equal(names.length, 4); assert.match(names[0]!.description, /'WING'/); assert.ok(names.every(action => !action.description.includes("name 'TWIN'")));
    assert.equal(current.actions.find(action => action.id === "press_start")!.frames, 1);
    assert.match(execute(fixture, reader, names[0]!.id), /submission sent once/);
    assert.equal(fixture.submitted, "WING"); assert.equal(fixture.confirmations, 1);
    assert.equal(fixture.inputs.filter(button => button === "A").length, 4);
    assert.equal(fixture.inputs.filter(button => button === "B").length, 10);
  });

  test(variant.name + " avoids current-box names, refreshes objective choices and keeps names within real grid limits", () => {
    const fixture = new PokemonTeamFixture(variant), reader = variant.create();
    fixture.ram[variant.items.boxCount] = 1; fixture.ram.set([...encodeTeamText("BIRD"), 0x50], variant.items.boxNicks);
    fixture.naming(); let current = snapshot(fixture, reader);
    assert.match(current.actions.find(action => action.id === "name_option_1")!.description, /'BIRDA'/);
    const key = current.actions.find(action => action.id === "name_option_1")!.availabilityKey;
    reader.setObjectives({ goal: "Inspect", constraints: ["Pokemon names: WING, WING, TOOLONGNAMEHERE, BIRD"], milestones: [] });
    current = snapshot(fixture, reader); assert.match(current.actions.find(action => action.id === "name_option_1")!.description, /'WING'/);
    assert.notEqual(current.actions.find(action => action.id === "name_option_1")!.availabilityKey, key);
    fixture.naming("", 0); current = snapshot(fixture, reader);
    assert.equal(current.state.values.namingKind, "player"); assert.match(current.actions[0]!.description, /'JEV'/);
    fixture.ram[variant.items.nameLength] = 8;
    assert.ok(!snapshot(fixture, reader).actions.some(action => action.id.startsWith("name_option_")));
  });

  test(variant.name + " keeps live names reserved after recent-name eviction and bounds a full party's naming state", () => {
    const fixture = new PokemonTeamFixture(variant), reader = variant.create();
    fixture.ram[variant.mon.partyCount] = 6; fixture.ram[variant.items.boxCount] = 20;
    for (let slot = 2; slot < 6; slot++) {
      fixture.ram.set(fixture.ram.slice(variant.mon.partyMons, variant.mon.partyMons + 44), variant.mon.partyMons + slot * 44);
      fixture.ram.set([...encodeTeamText("PAL" + String.fromCharCode(65 + slot)), 0x50], variant.mon.partyNicks + slot * 11);
    }
    for (let slot = 0; slot < 20; slot++) fixture.ram.set([...encodeTeamText("BOX" + String.fromCharCode(65 + slot)), 0x50], variant.items.boxNicks + slot * 11);
    snapshot(fixture, reader);
    for (let change = 0; change < 20; change++) {
      fixture.ram.set([...encodeTeamText("NEW" + String.fromCharCode(65 + change)), 0x50], variant.items.boxNicks + change * 11);
      snapshot(fixture, reader);
    }
    reader.setObjectives({ goal: "Choose a distinct name", constraints: ["Pokemon names: TWIN, PALC, NEWA, NOVA"], milestones: [] });
    fixture.naming(); const current = snapshot(fixture, reader);
    assert.match(current.actions.find(action => action.id === "name_option_1")!.description, /'NOVA'/);
    assert.equal(current.actions.filter(action => action.id.startsWith("name_option_")).length, 4);
  });

  test(variant.name + " identifies and targets the sixth party member without exceeding observation bounds", () => {
    const fixture = new PokemonTeamFixture(variant), reader = variant.create();
    fixture.ram[variant.mon.partyCount] = 6;
    for (let slot = 2; slot < 6; slot++) {
      fixture.ram.set(fixture.ram.slice(variant.mon.partyMons, variant.mon.partyMons + 44), variant.mon.partyMons + slot * 44);
      fixture.ram.set([...encodeTeamText("TWIN"), 0x50], variant.mon.partyNicks + slot * 11);
    }
    fixture.list(); execute(fixture, reader, "choose_medicine_slot_1");
    const current = snapshot(fixture, reader);
    assert.ok(current.actions.some(action => action.id === "apply_medicine_to_slot_6"));
    execute(fixture, reader, "apply_medicine_to_slot_6");
    assert.equal(fixture.ram[variant.mon.partyMons + 5 * 44 + 2], 30);
    assert.equal(fixture.ram[variant.mon.partyMons + 2], 10);
  });

  test(variant.name + " switches by party slot despite identical names and excludes the active or fainted member", () => {
    const fixture = new PokemonTeamFixture(variant), reader = variant.create(); fixture.party(2);
    const before = fixture.ram.slice(), current = snapshot(fixture, reader);
    assert.deepEqual(fixture.ram, before); assert.equal(current.state.values.battleMenu, "party");
    assert.equal(current.state.values.partySelection, 1);
    assert.ok(!current.actions.some(action => action.id === "select_party_slot_1" || action.id === "press_a"));
    assert.ok(!current.actions.some(action => action.id === "wait"), "A verified party choice needs input rather than more neutral waiting.");
    assert.match(current.actions.find(action => action.id === "select_party_slot_2")!.description, /slot 2.*TWIN.*speciesId=177/);
    assert.equal(reader.shouldWait(current.state, 0), false);
    fixture.hp(0, 0); assert.equal(reader.shouldWait(snapshot(fixture, reader).state, 0), false, "A visible replacement choice must not be treated as neutral faint settling.");
    fixture.ram[variant.menu.watchedKeys] = 1;
    assert.ok(!snapshot(fixture, reader).actions.some(action => action.id === "press_b"));
    assert.match(execute(fixture, reader, "select_party_slot_2"), /confirmation sent once/);
    assert.equal(fixture.ram[variant.menu.playerPartyIndex], 1); assert.equal(fixture.confirmations, 1);
    fixture.hp(0, 0); fixture.party(2);
    assert.ok(!snapshot(fixture, reader).actions.some(action => action.id.startsWith("select_party_")));
  });

  test(variant.name + " keeps a voluntary switch confirmation separate and protects delayed highlighted-party choices", () => {
    const fixture = new PokemonTeamFixture(variant), reader = variant.create(); fixture.party(0);
    execute(fixture, reader, "select_party_slot_2"); assert.equal(fixture.ram[variant.menu.playerPartyIndex], 0);
    let current = snapshot(fixture, reader);
    assert.equal(current.state.values.partyMenuKind, "confirm");
    assert.ok(current.actions.some(action => action.id === "confirm_switch_to_slot_2"));
    execute(fixture, reader, "confirm_switch_to_slot_2"); assert.equal(fixture.ram[variant.menu.playerPartyIndex], 1);
    fixture.party(2, 0); current = snapshot(fixture, reader);
    const old = current.actions.find(action => action.id === "press_a")!;
    fixture.party(2, 1); current = snapshot(fixture, reader);
    assert.ok(!current.actions.some(action => action.id === "press_a"));
    fixture.party(2, 0); fixture.hp(0, 1); current = snapshot(fixture, reader);
    assert.notEqual(current.actions.find(action => action.id === "press_a")!.availabilityKey, old.availabilityKey);
  });

  test(variant.name + " chooses one medicine then an explicit beneficial party slot, in battle and after it", () => {
    const fixture = new PokemonTeamFixture(variant), reader = variant.create(); fixture.list();
    let current = snapshot(fixture, reader);
    assert.ok(current.actions.some(action => action.id === "choose_medicine_slot_1"));
    assert.equal(current.actions.find(action => action.id === "press_a")!.frames, 1);
    execute(fixture, reader, "choose_medicine_slot_1");
    assert.equal(fixture.confirmations, 1); assert.equal(fixture.ram[variant.mon.bagItems + 1], 3, "Selecting medicine does not choose a recipient or consume it.");
    current = snapshot(fixture, reader);
    assert.equal(current.state.values.partyMenuKind, "medicine");
    assert.match(current.actions.find(action => action.id === "apply_medicine_to_slot_1")!.description, /SOOTHE.*slot 1.*restore up to 20 HP/);
    execute(fixture, reader, "apply_medicine_to_slot_1"); assert.equal(fixture.ram[variant.mon.battleMon + 2], 30);
    assert.equal(fixture.ram[variant.mon.bagItems + 1], 2); assert.equal(fixture.confirmations, 2);
    fixture.ram[variant.mon.battleKind] = 0; fixture.hp(1, 30, 8); fixture.list(1);
    execute(fixture, reader, "choose_medicine_slot_2"); current = snapshot(fixture, reader);
    assert.match(current.state.decisionSupport!.decisionGoal!, /Choose USE/);
    assert.equal(fixture.ram[variant.mon.partyMons + 44 + 4], 8);
    fixture.step("A"); current = snapshot(fixture, reader);
    assert.equal(current.state.values.partyMenuKind, "medicine");
    assert.ok(!current.actions.some(action => action.id === "apply_medicine_to_slot_1"));
    execute(fixture, reader, "apply_medicine_to_slot_2");
    assert.equal(fixture.ram[variant.mon.partyMons + 44 + 4], 0); assert.equal(fixture.ram[variant.mon.partyMons + 44 + 2], 30);
    assert.equal(fixture.ram[variant.mon.bagItems + 3], 1);
  });

  test(variant.name + " buys affordable medicine reserves and stops recommending more after stock is sufficient", () => {
    const fixture = new PokemonTeamFixture(variant), reader = variant.create(); fixture.ram[variant.mon.battleKind] = 0;
    fixture.bag([[4, 5]]); fixture.hp(0, 10, 8); fixture.list(0, true);
    let current = snapshot(fixture, reader);
    assert.match(current.actions.find(action => action.id === "choose_shop_item_slot_2")!.description, /Priority: obtain HP medicine.*unit price 300/);
    assert.match(current.actions.find(action => action.id === "choose_shop_item_slot_3")!.description, /Priority: obtain Antidotes.*unit price 100/);
    assert.match(current.state.decisionSupport!.decisionGoal!, /observed needs.*quantity.*price separately/);
    fixture.ram.fill(0, variant.mon.money, variant.mon.money + 3); current = snapshot(fixture, reader);
    assert.ok(!current.actions.some(action => action.id.startsWith("choose_shop_item_")));
    fixture.ram.set([0, 0x20, 0], variant.mon.money); fixture.bag([[4, 5], [20, 2], [11, 2]]); fixture.list(0, true);
    current = snapshot(fixture, reader);
    assert.ok(current.actions.filter(action => action.id.startsWith("choose_shop_item_")).every(action => !action.description.startsWith("Priority: obtain")));
  });

  test(variant.name + " identifies medicine after party drawing overwrites item, list and string aliases, including a restored selector", () => {
    const fixture = new PokemonTeamFixture(variant), reader = variant.create();
    fixture.ram[variant.mon.partyCount] = 6;
    for (let slot = 1; slot < 6; slot++) {
      fixture.ram.set(fixture.ram.slice(variant.mon.partyMons, variant.mon.partyMons + 44), variant.mon.partyMons + slot * 44);
      fixture.ram.set([...encodeTeamText("TWIN"), 0x50], variant.mon.partyNicks + slot * 11);
      fixture.hp(slot, 40);
    }
    fixture.ram[variant.mon.partyMons + 5 * 44] = 165;
    fixture.be(variant.mon.partyMons + 34, 24); fixture.loadActive(0); fixture.hp(0, 7);
    fixture.list(); execute(fixture, reader, "choose_medicine_slot_1");
    assert.equal(fixture.ram[variant.items.listId], 2);
    assert.equal(fixture.ram[variant.items.whichPokemon - 1], 165);
    assert.equal(fixture.ram[variant.items.stringBuffer], 0);
    const restoredReader = variant.create(), before = fixture.ram.slice(), current = snapshot(fixture, restoredReader);
    assert.deepEqual(fixture.ram, before);
    assert.match(current.state.values.partyMedicine as string, /SOOTHE; bag slot 1; quantity 3/);
    assert.deepEqual(current.actions.filter(action => action.id.startsWith("apply_medicine")).map(action => action.id), ["apply_medicine_to_slot_1"]);
    assert.match(current.state.decisionSupport!.decisionGoal!, /selected item is SOOTHE.*B cancels without healing/);
    assert.equal(restoredReader.shouldWait(current.state, 0), false);
    const key = current.actions.find(action => action.id === "apply_medicine_to_slot_1")!.availabilityKey;
    fixture.ram[variant.items.whichPokemon - 1] = 20; fixture.ram[variant.items.stringBuffer] = 0xff;
    assert.equal(snapshot(fixture, restoredReader).actions.find(action => action.id === "apply_medicine_to_slot_1")!.availabilityKey, key);
    restoredReader.reset(); execute(fixture, restoredReader, "apply_medicine_to_slot_1");
    assert.equal(fixture.ram[variant.mon.battleMon + 2], 24); assert.equal(fixture.ram[variant.mon.bagItems + 1], 2);
    fixture.party(1); const healed = snapshot(fixture, restoredReader);
    assert.ok(!healed.actions.some(action => action.id.startsWith("apply_medicine") || action.id === "press_a"));
    assert.match(healed.state.decisionSupport!.decisionGoal!, /no verified beneficial target.*B cancels/);
  });

  test(variant.name + " keeps a scrolled medicine's saved bag slot and rejects changed stock, pointers or party-menu meaning", () => {
    const setup = () => {
      const fixture = new PokemonTeamFixture(variant), reader = variant.create();
      fixture.hp(1, 40); fixture.bag([[4, 5], [1, 1], [2, 1], [3, 1], [20, 2], [11, 2]]); fixture.list(4);
      execute(fixture, reader, "choose_medicine_slot_5");
      return { fixture, reader };
    };
    const { fixture, reader } = setup();
    assert.equal(fixture.ram[variant.items.scroll], 2); assert.equal(fixture.ram[variant.items.bagSaved], 2);
    assert.match(snapshot(fixture, reader).state.values.partyMedicine as string, /SOOTHE; bag slot 5; quantity 2/);
    execute(fixture, reader, "apply_medicine_to_slot_1"); assert.equal(fixture.ram[variant.mon.bagItems + 9], 1);
    const changes = [
      (fixture: PokemonTeamFixture) => { fixture.ram[variant.mon.bagItems + 9] = 0; },
      (fixture: PokemonTeamFixture) => { fixture.ram[variant.items.bagSaved] = 3; },
      (fixture: PokemonTeamFixture) => { fixture.ram[variant.items.scroll] = 20; },
      (fixture: PokemonTeamFixture) => { fixture.ram.set([0, 0], variant.items.listPointer); },
      (fixture: PokemonTeamFixture) => { fixture.ram[variant.items.pseudoItem] = 1; },
      (fixture: PokemonTeamFixture) => { fixture.ram[variant.items.listId] = 3; },
      (fixture: PokemonTeamFixture) => { fixture.ram[variant.mon.bagItems + 12] = 0; },
      (fixture: PokemonTeamFixture) => { fixture.ram[variant.mon.bagItems + 2] = 4; },
    ];
    for (const change of changes) {
      const { fixture, reader } = setup(), chosen = snapshot(fixture, reader).actions.find(action => action.id === "apply_medicine_to_slot_1")!;
      const execution = reader.createExecution(fixture, chosen); change(fixture);
      const step = execution.next(); assert.equal(step.done, true);
      assert.ok(!snapshot(fixture, reader).actions.some(action => action.id.startsWith("apply_medicine")));
      assert.equal(fixture.confirmations, 1, "Context changes must not confirm treatment or choose another target.");
    }
  });

  test(variant.name + " settles incomplete medicine rendering and prompt printing without answering a party choice", () => {
    for (const field of [false, true]) {
      const fixture = new PokemonTeamFixture(variant), reader = variant.create(); fixture.list();
      execute(fixture, reader, "choose_medicine_slot_1");
      if (field) fixture.ram[variant.mon.battleKind] = 0;
      fixture.tiles().fill(0x7f, 15 * 20 + 1, 15 * 20 + 19);
      const before = fixture.ram.slice(), current = snapshot(fixture, reader);
      assert.equal(current.state.values.partyMenuKind, "medicine_pending");
      assert.equal(reader.shouldWait(current.state, 0), true);
      assert.ok(!current.actions.some(action => action.id.startsWith("apply_medicine")));
      for (let read = 0; read < 10; read++) snapshot(fixture, reader);
      assert.deepEqual(fixture.ram, before); assert.equal(fixture.confirmations, 1);
      fixture.party(1); const ready = snapshot(fixture, reader);
      assert.equal(ready.state.values.partyMenuKind, "medicine"); assert.equal(reader.shouldWait(ready.state, 0), false);
      assert.ok(ready.actions.some(action => action.id === "apply_medicine_to_slot_1"));
      if (!field) {
        fixture.tiles().fill(0x7f); const blank = snapshot(fixture, reader);
        assert.equal(blank.state.values.partyMenuKind, "medicine_pending"); assert.equal(reader.shouldWait(blank.state, 0), true);
        fixture.command(); assert.equal(reader.shouldWait(snapshot(fixture, reader).state, 0), false);
      }
    }
  });

  test(variant.name + " an offline agent waits through delayed medicine drawing and selects the useful recipient in two decisions", async () => {
    const fixture = new PokemonTeamFixture(variant); fixture.hp(1, 40); fixture.list();
    const step = fixture.step.bind(fixture); let drawingFrames = 0, neutralFrames = 0;
    fixture.step = (button: string) => {
      if (drawingFrames) {
        assert.equal(button, "", "Drawing settles without confirming or cancelling a recipient.");
        neutralFrames++; if (!--drawingFrames) fixture.party(1); return;
      }
      const wasBag = fixture.mode === "bag"; step(button);
      if (wasBag && button === "A" && fixture.mode === "party") { drawingFrames = 30; fixture.tiles().fill(0x7f); }
    };
    const emulator = fixtureEmulator(fixture), provider = createDefaultGameReaderRegistry().createFor(emulator, 24)!;
    const choices: string[] = [], ids = ["choose_medicine_slot_1", "apply_medicine_to_slot_1"];
    const session = new AgentSession(emulator, { mode: "mock", visionProvider: "none", observer: createStateObserver(provider),
      objectives: { goal: "Heal the injured first party slot", constraints: [], milestones: [] }, actionFrames: 24,
      maxDecisions: 2, maxSeconds: 60, budget: new RequestBudget({ maxRequests: 1, intervalMs: 0, retries: 0, timeoutMs: 1000 }),
      decider: { async decide(context) {
        const id = ids[choices.length]!; assert.ok(context.actions.some(action => action.id === id)); choices.push(id);
        assert.notEqual(context.gameState!.values.partyMenuKind, "medicine_pending");
        return { actionId: id, confidence: 1, probabilities: {}, model: "offline-healing-fixture", usage: { inputTokens: 0, outputTokens: 0 } };
      } } });
    await runAgentHeadless(emulator, session, new AbortController().signal, 1210);
    assert.deepEqual(choices, ids); assert.equal(neutralFrames, 30);
    assert.equal(fixture.ram[variant.mon.battleMon + 2], 30); assert.equal(fixture.ram[variant.mon.bagItems + 1], 2);
    assert.equal(fixture.confirmations, 2); assert.equal(session.snapshot.requests, 0);
  });

  test(variant.name + " preserves unknown medicine context and cancels changed-party execution without another target", () => {
    const fixture = new PokemonTeamFixture(variant), reader = variant.create(); fixture.list();
    execute(fixture, reader, "choose_medicine_slot_1");
    const action = snapshot(fixture, reader).actions.find(candidate => candidate.id === "apply_medicine_to_slot_2")!;
    const execution = reader.createExecution(fixture, action);
    fixture.hp(1, 40); const next = execution.next(); assert.equal(next.done, true);
    if (next.done) assert.match(next.reason, /context changed/);
    assert.equal(fixture.confirmations, 1);
    fixture.ram.set([0, 0], variant.items.listPointer); const current = snapshot(fixture, reader);
    assert.ok(!current.actions.some(candidate => candidate.id.startsWith("apply_medicine_")));
    assert.match(current.state.decisionSupport!.decisionGoal!, /Item identity is unknown/);
    fixture.romBytes.fill(0, variant.items.names, variant.items.names + 4096); reader.reset();
    assert.ok(!snapshot(fixture, reader).actions.some(candidate => candidate.id.startsWith("apply_medicine_")), "Two unknown names do not verify an item identity.");
  });

  test(variant.name + " medicine quantity prompts explain reserve needs and retain separate price confirmation", () => {
    const fixture = new PokemonTeamFixture(variant), reader = variant.create(); fixture.ram[variant.mon.battleKind] = 0;
    fixture.bag([[4, 5]]); fixture.list(0, true);
    fixture.tiles().fill(0x7f); fixture.box(7, 9, 19, 11);
    fixture.ram[variant.items.whichPokemon - 1] = 20; fixture.ram[variant.items.quantity] = 1;
    fixture.tiles().set([0xf1, 0xf6, 0xf7], 10 * 20 + 8);
    const current = snapshot(fixture, reader);
    assert.match(current.state.decisionSupport!.facts.join(" "), /Medicine quantity plan: SOOTHE.*suggests 2 additional/);
    assert.match(current.state.decisionSupport!.decisionGoal!, /separate total-price confirmation/);
    assert.equal(current.actions.find(action => action.id === "press_a")!.frames, 1);
    assert.equal(fixture.confirmations, 0);
  });
}

test("medicine advice uses matching live battle HP/status and distinguishes healing from poison cure", () => {
  const fixture = new PokemonTeamFixture(), { mon, menu } = fixture.variant;
  fixture.be(mon.partyMons + 1, 40); fixture.be(mon.battleMon + 1, 5); fixture.ram[mon.battleMon + 4] = 8;
  const members = pokemonPartyMembers(fixture.ram.subarray(0xc000, 0xe000), mon, menu, true);
  assert.equal(members[0]!.hp, 5); assert.equal(members[0]!.status, 8);
  assert.match(medicineBenefit(20, members[0]!)!, /restore up to 20 HP.*no status cure/);
  assert.match(medicineBenefit(11, members[0]!)!, /no HP restoration.*cure the matching status/);
  assert.equal(medicineBenefit(20, { ...members[0]!, hp: 0 }), undefined);
  assert.equal(medicineBenefit(20, { ...members[0]!, hp: 40, status: 0 }), undefined);
});

test("naming execution is bounded for ignored controls and stops when the offered name changes", () => {
  let state: PokemonNamingState = { context: "grid", entered: "", row: 1, x: 1, upper: true, names: ["A"] };
  let execution = pokemonNamingExecution("A", () => state), confirmations = 0, done = false;
  for (let frame = 0; frame < 150; frame++) {
    const step = execution.next(); if (step.done) { assert.match(step.reason, /expected text/); done = true; break; }
    confirmations += Number(step.buttons.includes("A"));
  }
  assert.equal(done, true); assert.equal(confirmations, 1);
  execution = pokemonNamingExecution("A", () => state); state = { ...state, names: ["B"] };
  assert.equal(execution.next().done, true);
});

test("a selected field medicine bag opens START and ITEM with bounded single confirmations", () => {
  let state: PokemonItemExecutionState = { context: "field", menu: "overworld", commandX: 0, commandY: 0, selected: 0, slots: [] };
  const execution = pokemonItemExecution({ kind: "medicine_bag" }, () => state, 8), keys: string[] = [];
  for (let frame = 0; frame < 100; frame++) {
    const step = execution.next(); if (step.done) { assert.match(step.reason, /bag opened/); break; }
    const button = step.buttons[0]; if (button) keys.push(button);
    if (button === "START") state = { ...state, menu: "start", selected: 2, itemRow: 4 };
    if (button === "DOWN") state = { ...state, selected: state.selected + 2 };
    if (button === "A") state = { ...state, menu: "bag" };
  }
  assert.deepEqual(keys, ["START", "DOWN", "A"]);
});

test("opening a party or medicine menu from moves sends B only once before navigating commands", () => {
  let battle: PokemonMoveExecutionState = { context: "actors", menu: "moves", selectedSlot: 1, usableSlots: [1], commandX: 9, commandY: 16 };
  let partyOpen = false;
  const execution = pokemonPartyMenuExecution(() => ({ battle, partyOpen })), keys: string[] = [];
  for (let frame = 0; frame < 100; frame++) {
    const step = execution.next(); if (step.done) break;
    const button = step.buttons[0]; if (button) keys.push(button);
    if (button === "B") battle = { ...battle, menu: "command" };
    if (button === "RIGHT") battle = { ...battle, commandX: 15 };
    if (button === "UP") battle = { ...battle, commandY: 14 };
    if (button === "A") partyOpen = true;
  }
  assert.deepEqual(keys, ["B", "RIGHT", "UP", "A"]);
  let item: PokemonItemExecutionState = { context: "actors", menu: "moves", commandX: 9, commandY: 16, selected: 0, slots: [] };
  const medicine = pokemonItemExecution({ kind: "medicine_bag" }, () => item, 8), itemKeys: string[] = [];
  for (let frame = 0; frame < 100; frame++) {
    const step = medicine.next(); if (step.done) break;
    const button = step.buttons[0]; if (button) itemKeys.push(button);
    if (button === "B") item = { ...item, menu: "command" };
    if (button === "A") item = { ...item, menu: "bag" };
  }
  assert.deepEqual(itemKeys, ["B", "A"]);
});

test("typed Jev questions include slot identities and whole-name choices without sending inputs", () => {
  const fixture = new PokemonTeamFixture(), reader = fixture.variant.create(); fixture.party(2);
  const { state, actions } = snapshot(fixture, reader);
  const request = evaluationRequest({ objectives: { goal: "Switch to the intended member", constraints: [], milestones: [] },
    console: "game-boy", frame: 0, observation: "Party list", unchangedScreens: 0, history: [], actions, gameState: state }, "offline-team-fixture");
  assert.match(request.questions.next_action.criteria.select_party_slot_2!, /slot 2.*speciesId=177/);
  assert.match(request.state.gameState!.decisionSupport!.decisionGoal!, /party slot/);
  assert.equal(fixture.inputs.length, 0);
});

test("an offline agent selects an Antidote, USE and the poisoned party slot separately, consuming exactly one item", async () => {
  const fixture = new PokemonTeamFixture(), { mon } = fixture.variant;
  fixture.ram[mon.battleKind] = 0; fixture.hp(1, 30, 8); fixture.list(1);
  const emulator = fixtureEmulator(fixture);
  const provider = createDefaultGameReaderRegistry().createFor(emulator, 24)!;
  const chosen: string[] = [], ids = ["choose_medicine_slot_2", "press_a", "apply_medicine_to_slot_2"];
  const session = new AgentSession(emulator, { mode: "mock", visionProvider: "none", observer: createStateObserver(provider),
    objectives: { goal: "Cure the poisoned second party member", constraints: [], milestones: [] }, actionFrames: 24,
    maxDecisions: 3, maxSeconds: 60, budget: new RequestBudget({ maxRequests: 1, intervalMs: 0, retries: 0, timeoutMs: 1000 }),
    decider: { async decide(context) {
      const id = ids[chosen.length]!; assert.ok(context.actions.some(action => action.id === id)); chosen.push(id);
      if (id.startsWith("apply_medicine")) assert.match(evaluationRequest(context, "offline-medicine-fixture").questions.next_action.criteria[id]!, /PUREDROP.*slot 2.*cure/);
      return { actionId: id, confidence: 1, probabilities: {}, model: "offline-medicine-fixture", usage: { inputTokens: 0, outputTokens: 0 } };
    } },
  });
  await runAgentHeadless(emulator, session, new AbortController().signal, 1812);
  assert.deepEqual(chosen, ids); assert.equal(fixture.ram[mon.partyMons + 44 + 4], 0);
  assert.equal(fixture.ram[mon.bagItems + 3], 1); assert.equal(fixture.confirmations, 3);
  assert.equal(session.snapshot.requests, 0); assert.equal(fixture.inputs.at(-1), "");
});

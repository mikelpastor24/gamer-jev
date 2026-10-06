import assert from "node:assert/strict";
import { test } from "node:test";
import { PokemonMapGraph } from "../src/profiles/pokemon/map-graph.js";
import { pokemonNavigationExecution, PokemonRouteFeedback, type PokemonRoute } from "../src/profiles/pokemon/navigation-execution.js";
import type { GameStateData } from "../src/core/game-reader.js";
import { PokemonStoryProgress } from "../src/profiles/pokemon/progress.js";
import { pokemonObjectives } from "../src/profiles/pokemon/objectives.js";
import { PokemonTravelMemory } from "../src/profiles/pokemon/travel-memory.js";

for (const yellow of [false, true]) {
  test(`${yellow ? "Yellow" : "Red/Blue"} map connectivity uses its own header tables and only known outdoor LAST_MAP returns`, () => {
    const bytes = new Uint8Array(64 * 0x4000);
    const pointers = yellow ? 63 * 0x4000 + 0x1f2 : 0x1ae;
    const banks = yellow ? 63 * 0x4000 + 0x3e4 : 3 * 0x4000 + 0x23d;
    const word = (offset: number, value: number) => bytes.set([value & 255, value >> 8], offset);
    const entries = [[0, [12, 37, 42]], [12, [0]], [37, [255, 38]], [38, [37]], [42, []]] as const;
    for (const [index, [id, destinations]] of entries.entries()) {
      bytes[banks + id] = 2;
      word(pointers + id * 2, 0x5000 + index * 32);
      const header = 2 * 0x4000 + 0x1000 + index * 32;
      bytes.set([0, 4, 4], header);
      word(header + 10, 0x5800 + index * 64);
      const objects = 2 * 0x4000 + 0x1800 + index * 64;
      bytes[objects + 1] = destinations.length;
      destinations.forEach((destination, warp) => bytes.set([1, 1, 1, destination], objects + 2 + warp * 4));
    }
    const graph = new PokemonMapGraph();
    let reads = 0;
    const byte = (offset: number) => { reads++; assert.ok(offset >= 0 && offset < bytes.length); return bytes[offset]!; };
    assert.equal(graph.distance(38, 12, byte, yellow, bytes.length), 3);
    assert.equal(graph.distance(37, 0, byte, yellow, bytes.length), 1);
    assert.equal(graph.distance(42, 0, byte, yellow, bytes.length), undefined);
    const count = reads;
    graph.distance(0, 12, byte, yellow, bytes.length); assert.equal(reads, count);
    graph.reset(); graph.distance(0, 12, byte, yellow, bytes.length); assert.ok(reads > count);
    const unavailable = new PokemonMapGraph();
    assert.equal(unavailable.distance(0, 12, () => { throw new Error("Unknown ROM"); }, yellow, 0), undefined);
  });
}

test("navigation keeps the chosen target, waits for movement, turns to interact, and stops when dialogue opens", () => {
  let values: GameStateData["values"] = { phase: "overworld", mapId: 0, playerX: 1, playerY: 2, facing: "up" };
  let route: PokemonRoute | undefined = { id: "interact_object_1", context: "0:custom", label: "Object 1", length: 2, nextButtons: ["RIGHT"], interact: true, x: 4, y: 2, towardObjective: false };
  const outcomes: string[] = [];
  const execution = pokemonNavigationExecution(route.id, () => ({ state: { values, descriptions: {} }, route }), 3, (_target, _progress, reason) => outcomes.push(reason));
  assert.deepEqual(execution.next(), { done: false, buttons: ["RIGHT"] });
  values = { ...values, movementInProgress: true }; route = undefined;
  assert.deepEqual(execution.next(), { done: false, buttons: [] });
  values = { ...values, movementInProgress: false, playerX: 3 };
  route = { id: "interact_object_1", context: "0:custom", label: "Object 1", length: 0, nextButtons: [], interact: true, x: 4, y: 2, towardObjective: false };
  for (let frame = 0; frame < 4; frame++) assert.deepEqual(execution.next(), { done: false, buttons: [] });
  assert.deepEqual(execution.next(), { done: false, buttons: ["RIGHT"] });
  values = { ...values, facing: "right" };
  for (let frame = 0; frame < 6; frame++) execution.next();
  assert.deepEqual(execution.next(), { done: false, buttons: ["A"] });
  values = { ...values, phase: "text" };
  assert.match((execution.next() as { reason: string }).reason, /interrupted/);
  execution.finish!("Dialogue interrupted navigation."); execution.finish!("Duplicate completion.");
  assert.deepEqual(outcomes, ["Dialogue interrupted navigation."]);
});

test("a selected grass square finishes on arrival without sending another input or choosing another square", () => {
  let values: GameStateData["values"] = { phase: "overworld", mapId: 12, playerX: 1, playerY: 2 };
  let route: PokemonRoute | undefined = { id: "walk_grass_2_2", context: "12:train", label: "Grass", length: 1,
    nextButtons: ["RIGHT"], interact: false, arrivalOnly: true, x: 2, y: 2, towardObjective: false };
  const execution = pokemonNavigationExecution(route.id, () => ({ state: { values, descriptions: {} }, route }), 8, () => {});
  assert.deepEqual(execution.next(), { done: false, buttons: ["RIGHT"] });
  values = { ...values, playerX: 2, movementInProgress: true }; route = undefined;
  assert.deepEqual(execution.next(), { done: false, buttons: [] });
  values = { ...values, movementInProgress: false };
  assert.deepEqual(execution.next(), { done: true, reason: "Selected walking square reached; reassess observed encounters." });
});

test("a selected long route yields once a new pickup becomes nearby without selecting or collecting it", () => {
  let state: GameStateData = { values: { phase: "overworld", mapId: 12, playerX: 0, playerY: 0 }, descriptions: {} };
  const route: PokemonRoute = { id: "go_exit_1", context: "12:progress", label: "Exit", length: 20,
    nextButtons: ["RIGHT"], interact: false, x: 20, y: 0, towardObjective: true };
  let nearbyPickups = ["interact_object_1"];
  const read = () => ({ state, route, nearbyPickups });
  const execution = pokemonNavigationExecution(route.id, read, 1, () => {});
  assert.deepEqual(execution.next(), { done: false, buttons: ["RIGHT"] });
  nearbyPickups = ["interact_object_1", "interact_object_2"];
  state = { ...state, values: { ...state.values, movementInProgress: true } };
  assert.deepEqual(execution.next(), { done: false, buttons: [] }, "Walking settles before requesting a new decision.");
  state = { ...state, values: { ...state.values, movementInProgress: false, playerX: 1 } };
  const next = execution.next(); assert.equal(next.done, true);
  if (next.done) assert.match(next.reason, /new nearby collectible.*Jev must reassess/);
  const continued = pokemonNavigationExecution(route.id, read, 1, () => {});
  assert.equal(continued.next().done, false, "Jev can deliberately continue past an already observed opportunity.");
  const pickup = { ...route, id: "interact_object_2", label: "Item ball: TEST", interact: true };
  const selectedPickup = pokemonNavigationExecution(pickup.id, () => ({ state, route: pickup, nearbyPickups }), 1, () => {});
  nearbyPickups.push("interact_object_3");
  assert.equal(selectedPickup.next().done, false, "Another pickup cannot replace or interrupt the selected pickup target.");
});

test("unreachable and stagnant targets are bounded and cannot substitute another action", () => {
  const route: PokemonRoute = { id: "go_exit_1", context: "37:meet_oak", label: "Exit", length: 0, nextButtons: [], interact: false, x: 1, y: 1, towardObjective: true };
  const state = { values: { phase: "overworld", mapId: 37, playerX: 1, playerY: 1 }, descriptions: {} };
  const stalled = pokemonNavigationExecution(route.id, () => ({ state, route }), 8, () => {});
  for (let frame = 0; frame < 120; frame++) assert.equal(stalled.next().done, false);
  assert.match((stalled.next() as { reason: string }).reason, /No settled movement/);
  let current: PokemonRoute | undefined = route;
  const missing = pokemonNavigationExecution(route.id, () => ({ state, route: current }), 8, () => {});
  current = undefined; assert.match((missing.next() as { reason: string }).reason, /no longer reachable/);
  current = route;
  const replaced = pokemonNavigationExecution(route.id, () => ({ state, route: current }), 8, () => {});
  current = { ...route, id: "go_exit_2" };
  assert.throws(() => replaced.next(), /substitute/);
  current = route;
  const changed = pokemonNavigationExecution(route.id, () => ({ state, route: current }), 8, () => {});
  current = { ...route, context: "37:custom" };
  assert.match((changed.next() as { reason: string }).reason, /context changed/);
});

test("story checks follow supplied milestones and preserve subgoals until their event flags are present", () => {
  const story = new PokemonStoryProgress(false), flags = new Uint8Array(320);
  const set = (bit: number) => flags[bit >> 3]! |= 1 << (bit & 7);
  const values = { gameStarted: true, phase: "overworld", mapId: 0, badges: "none", badgeCount: 0 };
  story.setObjectives({ ...pokemonObjectives("choice"), milestones: [pokemonObjectives("choice").milestones[10]!] });
  assert.equal(story.read(flags, values)!.objective!.map, 148);
  set(1231); assert.equal(story.read(flags, values)!.objective!.map, 149);
  set(296); assert.equal(story.read(flags, values)!.objective, undefined);
  assert.match(story.read(flags, values)!.values.completedStoryChecks, /poke_flute/);
  assert.match(story.read(flags, values)!.facts.join(" "), /All recognized supplied story checkpoints/);
  story.setObjectives({ goal: "Custom task", constraints: [], milestones: ["Find an unusual sign"] });
  assert.equal(story.read(flags, values)!.objective, undefined);
  assert.equal(story.read(new Uint8Array(), values), undefined);
  story.setObjectives({ ...pokemonObjectives("choice"), milestones: [pokemonObjectives("choice").milestones[3]!, pokemonObjectives("choice").milestones[0]!] });
  assert.equal(story.read(new Uint8Array(320), values)!.objective!.id, "collect_parcel");
});

test("repeated partial approaches retain the best observed distance until story evidence or map transition changes", () => {
  const feedback = new PokemonRouteFeedback();
  const route: PokemonRoute = { id: "go_exit_1", context: "37:meet_oak", label: "Exit", length: 10, nextButtons: ["DOWN"], interact: false, x: 1, y: 1, towardObjective: true };
  const outcome = { closestDistance: 5, mapChanged: false };
  feedback.remember(route, outcome); assert.equal(feedback.attempts(route), 0);
  feedback.remember(route, outcome); assert.equal(feedback.attempts(route), 1);
  feedback.remember(route, outcome); assert.equal(feedback.attempts(route), 2);
  feedback.remember(route, { ...outcome, closestDistance: 4 }); assert.equal(feedback.attempts(route), 0);
  assert.equal(feedback.attempts({ ...route, context: "38:meet_oak" }), 0);
  feedback.remember(route, { ...outcome, mapChanged: true }); assert.equal(feedback.attempts(route), 0);
  for (let index = 0; index < 33; index++) feedback.remember({ ...route, id: `target_${index}` }, { ...outcome, closestDistance: 10 });
  assert.equal(feedback.attempts({ ...route, id: "target_0" }), 0);
  assert.equal(feedback.attempts({ ...route, id: "target_32" }), 1);
  feedback.reset(); assert.equal(feedback.attempts({ ...route, id: "target_32" }), 0);
});

test("defeating the hideout boss does not prove the Silph Scope was collected", () => {
  const story = new PokemonStoryProgress(false), flags = new Uint8Array(320);
  flags[1703 >> 3]! |= 1 << (1703 & 7);
  const values = { gameStarted: true, phase: "overworld", mapId: 203, badges: "Rainbow", badgeCount: 1 };
  story.setObjectives({ ...pokemonObjectives("choice"), milestones: [pokemonObjectives("choice").milestones[9]!] });
  const pending = story.read(flags, values)!;
  assert.equal(pending.objective!.map, 203); assert.equal(pending.values.completedStoryChecks, "none");
  assert.match(pending.facts.join(" "), /Defeating the boss alone does not collect/);
  assert.equal(story.read(flags, values, [0x48])!.objective, undefined);
});

test("League guidance follows the named room battle flags independently of unrelated Victory Road flags", () => {
  for (const yellow of [false, true]) {
    const story = new PokemonStoryProgress(yellow), flags = new Uint8Array(320);
    const defaults = pokemonObjectives(yellow ? "pikachu" : "choice");
    story.setObjectives({ ...defaults, milestones: [defaults.milestones[15]!] });
    const values = { gameStarted: true, phase: "overworld", mapId: 9, badges: "all", badgeCount: 8 };
    const set = (bit: number) => flags[bit >> 3]! |= 1 << (bit & 7);
    set(2241); assert.equal(story.read(flags, values)!.objective!.map, 245);
    for (const [bit, destination] of [[2273, 246], [2281, 247], [2289, 113], [2297, 120]]) {
      set(bit!); assert.equal(story.read(flags, values)!.objective!.map, destination);
    }
    set(2305); assert.equal(story.read(flags, values)!.objective, undefined);
  }
});

test("Lavender arrival requires a settled overworld observation and is cleared on reset", () => {
  const story = new PokemonStoryProgress(false), flags = new Uint8Array(320), defaults = pokemonObjectives("choice");
  story.setObjectives({ ...defaults, milestones: [defaults.milestones[8]!] });
  const values = { gameStarted: true, phase: "overworld", mapId: 4, badges: "none", badgeCount: 0 };
  assert.ok(story.read(flags, { ...values, movementInProgress: true })!.objective);
  assert.ok(story.read(flags, { ...values, controlBusy: true })!.objective);
  assert.ok(story.read(flags, { ...values, phase: "transition" })!.objective);
  assert.equal(story.read(flags, values)!.objective, undefined);
  story.reset(); assert.ok(story.read(flags, { ...values, mapId: 0 })!.objective);
});

test("travel memory retains return crossings across long battles and ignores unstable and duplicate snapshots", () => {
  const memory = new PokemonTravelMemory();
  const evidence = "brock:none:empty:one-party-member";
  memory.observe(13, true, evidence);
  memory.observe(50, false, evidence); // Transient map bytes do not establish a settled arrival.
  assert.deepEqual(memory.routeFacts(13, 50), []);
  memory.observe(50, true, evidence);
  assert.match(memory.routeFacts(50, 13).join(" "), /map this visit came from/);
  memory.observe(13, true, evidence); memory.observe(50, true, evidence); memory.observe(13, true, evidence);
  for (let snapshot = 0; snapshot < 100; snapshot++) {
    memory.observe(13, false, evidence); memory.observe(13, true, evidence);
  }
  assert.match(memory.facts(13).join(" "), /repeated return crossings.*Viridian Forest south gate/);
  assert.match(memory.routeFacts(13, 50).join(" "), /3 immediate return crossings.*2 previous crossings/);
  assert.deepEqual(memory.routeFacts(13, 1), []); // Another legal destination gets no invented loop warning.
  memory.observe(13, true, "brock:none:new-item:one-party-member");
  assert.deepEqual(memory.facts(13), []); assert.deepEqual(memory.routeFacts(13, 50), []);
  memory.observe(50, true, "brock:none:new-item:one-party-member"); memory.reset();
  assert.deepEqual(memory.routeFacts(50, 13), []);
});

test("travel memory does not label onward traversal through both forest gates as an immediate return loop and stays bounded", () => {
  const memory = new PokemonTravelMemory();
  for (const map of [13, 50, 51, 47, 13, 2]) memory.observe(map, true, "same-evidence");
  assert.deepEqual(memory.facts(13), []);
  assert.doesNotMatch(memory.routeFacts(13, 50).join(" "), /return crossings/);
  for (let cycle = 0; cycle < 8; cycle++) for (const map of [1, 13, 1]) memory.observe(map, true, "same-evidence");
  assert.match(memory.facts(1).join(" "), /repeated return crossings/);
  for (let map = 60; map < 100; map++) memory.observe(map, true, "same-evidence");
  assert.deepEqual(memory.facts(1), []); assert.deepEqual(memory.routeFacts(13, 1), []);
});

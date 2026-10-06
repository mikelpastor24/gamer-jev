import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompletedGameAction, StateValue } from "../src/core/agent.js";
import { PokemonFocusMemory, type PokemonFocus } from "../src/profiles/pokemon/focus.js";

const initial: Readonly<Record<string, StateValue>> = {
  gameStarted: true, phase: "overworld", mapId: 2, playerX: 4, playerY: 8,
  badges: 0, bagItems: "none", partyCount: 1,
  party1: "TEST; speciesId=176; level=11; HP=25/31; Fire; healthy",
  party1Moves: "slot1: id=33,PP=20",
};
function choose(memory: PokemonFocusMemory, focus: PokemonFocus) {
  const choices = memory.choices(initial, [focus]);
  assert.deepEqual(choices[0]!.buttons, []);
  const executor = memory.select(choices[0]!.id);
  assert.equal(executor.next().done, true);
  return executor;
}
function completed(map = 2, id = "go_exit_1", phase = "overworld", interrupted = false): CompletedGameAction {
  return { action: { id, description: "Fixture action", buttons: [], frames: 600, stop: false, execution: "profile" },
    record: { actionId: id, fromFrame: 0, toFrame: 604, observation: "fixture", interrupted, executionReason: "Map changed." },
    before: { source: "fixture", frame: 0, values: { ...initial, mapId: map, phase }, descriptions: {} },
    after: { source: "fixture", frame: 604, values: { ...initial, mapId: map + 1 }, descriptions: {} } };
}

test("only executing Jev's offered focus selects a purpose; reads, maps and incidental battles preserve it", () => {
  const memory = new PokemonFocusMemory(); memory.observe(initial, "opening");
  memory.choices(initial, ["shop", "progress"]);
  assert.equal(memory.current, undefined);
  assert.throws(() => memory.select("focus_heal"), /no longer offered/);
  choose(memory, "shop"); const version = memory.version;
  for (let i = 0; i < 100; i++) memory.observe({ ...initial, mapId: i % 2 ? 56 : 2, phase: i % 3 ? "overworld" : "battle",
    playerX: i, party1: "TEST; speciesId=176; level=12; HP=20/31; Fire; healthy" }, "opening");
  assert.equal(memory.current, "shop"); assert.equal(memory.version, version);
  memory.complete(completed(2, "focus_shop")); memory.complete(completed(56, "press_a", "battle"));
  memory.complete(completed(2, "go_exit_1", "overworld", true));
  assert.match(memory.facts().join(" "), /0\/32/);
});

test("returning to previous distances does not reset stagnation; a six-action cycle requires another Jev purpose", () => {
  const memory = new PokemonFocusMemory(); memory.observe(initial, "opening"); choose(memory, "shop");
  memory.distance(2, 5); memory.distance(1, 4); memory.complete(completed()); // A genuinely new best.
  for (let i = 0; i < 5; i++) {
    memory.distance(i % 2 ? 1 : 2, i % 2 ? 4 : 5); memory.complete(completed(i % 2 ? 56 : 2));
  }
  assert.equal(memory.current, "shop");
  memory.distance(1, 4); memory.complete(completed(56));
  assert.equal(memory.current, undefined); assert.match(memory.facts().join(" "), /Six completed actions/);
  assert.match(memory.attemptFact(56, "go_exit_1")!, /3 time\(s\)/);
  const choices = memory.choices(initial, ["shop", "progress"]);
  assert.match(choices[0]!.description, /Selected 1 time/);
  choose(memory, "progress"); assert.ok(memory.attemptFact(56, "go_exit_1"));
  memory.observe({ ...initial, bagItems: "BALL x1" }, "opening");
  assert.equal(memory.current, undefined); assert.equal(memory.attemptFact(56, "go_exit_1"), undefined);
});

test("a purpose still receives a 32-action review when distances keep improving", () => {
  const memory = new PokemonFocusMemory(); memory.observe(initial, "opening"); choose(memory, "progress");
  memory.distance(1, 100);
  for (let i = 1; i <= 31; i++) { memory.distance(1, 100 - i); memory.complete(completed()); }
  assert.equal(memory.current, "progress");
  memory.distance(1, 68); memory.complete(completed());
  assert.equal(memory.current, undefined); assert.match(memory.facts().join(" "), /32-action review/);
});

test("durable story, badges, inventory, team and critical health changes invalidate focus; coordinates and levels do not", () => {
  for (const [change, checks] of [
    [{ badges: 1 }, "opening"], [{ bagItems: "BALL x1" }, "opening"], [{ partyCount: 2 }, "opening"],
    [{ party1: "TEST; speciesId=99; level=11; HP=25/31; Water; healthy" }, "opening"],
    [{ party1: "TEST; speciesId=176; level=11; HP=2/31; Fire; healthy" }, "opening"], [{}, "opening,brock"],
  ] as const) {
    const memory = new PokemonFocusMemory(); memory.observe(initial, "opening"); choose(memory, "progress");
    memory.observe({ ...initial, ...change }, checks); assert.equal(memory.current, undefined);
  }
  const memory = new PokemonFocusMemory(); memory.observe(initial, "opening"); choose(memory, "explore");
  memory.observe({ ...initial, playerX: 99, mapId: 54, party1: "TEST; speciesId=176; level=12; HP=25/31; Fire; healthy" }, "opening");
  assert.equal(memory.current, "explore"); memory.reset(); assert.equal(memory.current, undefined);
  assert.throws(() => memory.select("focus_explore"), /no longer offered/);
});

test("observed training levels and changed healing state are scoped to their selected purpose", () => {
  const memory = new PokemonFocusMemory(); memory.observe(initial, "opening"); choose(memory, "train");
  for (let i = 0; i < 5; i++) memory.complete(completed());
  memory.observe({ ...initial, party1: "TEST; speciesId=176; level=12; HP=25/31; Fire; healthy" }, "opening");
  memory.complete(completed()); assert.equal(memory.current, "train");
  memory.reset(); memory.observe(initial, "opening"); choose(memory, "heal");
  memory.observe(initial, "opening"); assert.equal(memory.current, "heal");
  memory.observe({ ...initial, party1: "TEST; speciesId=176; level=11; HP=31/31; Fire; healthy" }, "opening");
  assert.equal(memory.current, undefined); assert.match(memory.facts()[0]!, /Full party HP/);
  memory.reset(); memory.observe(initial, "opening"); choose(memory, "train");
  for (let i = 0; i < 5; i++) memory.complete(completed());
  memory.observe({ ...initial, party1: "TEST; speciesId=176; level=10; HP=25/31; Fire; healthy" }, "opening");
  memory.complete(completed()); assert.equal(memory.current, undefined); // A lower level is not training progress.
});

test("explicit reconsideration is idempotent and repeated outcomes stay bounded", () => {
  const memory = new PokemonFocusMemory(); memory.observe(initial, "opening"); choose(memory, "explore");
  const executor = memory.review(); executor.next(); const version = memory.version;
  executor.next(); assert.equal(memory.version, version); assert.equal(memory.current, undefined);
  for (let i = 0; i < 75; i++) { choose(memory, "explore"); memory.complete(completed(i)); }
  assert.equal(memory.attemptFact(0, "go_exit_1"), undefined);
  choose(memory, "explore"); memory.complete(completed(74));
  assert.match(memory.attemptFact(74, "go_exit_1")!, /2 time\(s\)/);
  assert.ok(memory.facts().every(fact => fact.length <= 500));
});

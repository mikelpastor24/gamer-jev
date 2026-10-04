import assert from "node:assert/strict";
import { test } from "node:test";
import { PokemonInteractionMemory } from "../src/profiles/pokemon/interaction-memory.js";

test("interaction memory stays bounded across many locations and retains the latest information", () => {
  const memory = new PokemonInteractionMemory();
  const flags = new Uint8Array(320);
  const base = { gameStarted: true, mapId: 37, playerX: 5, playerY: 3, facing: "down", partyCount: 0, bagItems: "empty" };
  for (let mapId = 0; mapId < 40; mapId++) {
    for (let page = 0; page < 40; page++) memory.read({ ...base, mapId, phase: "text", dialogueActive: true, screenTextBottom: `Page ${page}: ${"a".repeat(250)}` }, flags);
    const snapshot = memory.read({ ...base, mapId, phase: "overworld", dialogueActive: false }, flags);
    assert.equal(snapshot.values.completedDialoguesHere, 1);
    assert.ok(String(snapshot.values.lastDialogueText).length <= 256);
    assert.ok(snapshot.decisionSupport!.facts.every(fact => fact.length <= 500));
  }
  assert.equal(memory.read({ ...base, mapId: 0, phase: "overworld", dialogueActive: false }, flags).values.completedDialoguesHere, undefined);
  assert.equal(memory.read({ ...base, mapId: 39, phase: "overworld", dialogueActive: false }, flags).values.completedDialoguesHere, 1);
});

test("interaction memory treats healing and other tracked changes as new evidence while leaving repeat interactions available", () => {
  const memory = new PokemonInteractionMemory();
  const flags = new Uint8Array(320);
  const base = { gameStarted: true, mapId: 1, playerX: 1, playerY: 1, facing: "up", party1: "HP=1/20", bagItems: "empty" };
  memory.read({ ...base, phase: "text", dialogueActive: true, screenTextBottom: "Healing" }, flags);
  const healed = { ...base, party1: "HP=20/20", phase: "overworld", dialogueActive: false };
  assert.equal(memory.read(healed, flags).values.lastDialogueStateChanged, true);
  memory.read({ ...healed, phase: "text", dialogueActive: true, screenTextBottom: "Already healed" }, flags);
  assert.match(memory.read(healed, flags).decisionSupport!.actionFacts.press_a!.join(" "), /Already completed 2/);
  const injured = memory.read({ ...healed, party1: "HP=1/20" }, flags);
  assert.equal(injured.decisionSupport!.actionFacts.press_a, undefined);
  memory.reset(); assert.equal(memory.read(healed, flags).values.lastDialogueText, undefined);
});

test("returning to an earlier interaction keeps its text even after another conversation", () => {
  const memory = new PokemonInteractionMemory();
  const flags = new Uint8Array(320);
  const base = { gameStarted: true, mapId: 37, playerX: 1, playerY: 1, facing: "up", partyCount: 0 };
  memory.read({ ...base, phase: "text", dialogueActive: true, screenTextBottom: "Visit the lab" }, flags);
  memory.read({ ...base, phase: "overworld", dialogueActive: false }, flags);
  memory.read({ ...base, playerX: 2, phase: "text", dialogueActive: true, screenTextBottom: "Another conversation" }, flags);
  memory.read({ ...base, playerX: 2, phase: "overworld", dialogueActive: false }, flags);
  const returned = memory.read({ ...base, phase: "overworld", dialogueActive: false }, flags);
  assert.equal(returned.values.lastDialogueText, "Another conversation");
  assert.equal(returned.values.lastDialogueHere, "Visit the lab");
  assert.equal(returned.values.completedDialoguesHere, 1);
  assert.match(returned.decisionSupport!.facts.join(" "), /Previous dialogue from this position\/facing: Visit the lab/);
});

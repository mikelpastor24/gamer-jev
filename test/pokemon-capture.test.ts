import assert from "node:assert/strict";
import { test } from "node:test";
import { pokemonCaptureBallEvidence } from "../src/profiles/pokemon/capture-support.js";

test("Gen I ball HP factors plateau with exact integer rounding, including small HP totals", () => {
  const poke = pokemonCaptureBallEvidence(4, 100, 100, 0, 100)!;
  const great = pokemonCaptureBallEvidence(3, 100, 100, 0, 100)!;
  assert.equal(poke.plateauHP, 35); assert.equal(great.plateauHP, 51);
  assert.equal(poke.hpFactor, 85); assert.equal(great.hpFactor, 127);
  assert.equal(pokemonCaptureBallEvidence(4, 36, 100, 0, 100)!.optimalHP, false);
  assert.equal(pokemonCaptureBallEvidence(4, 35, 100, 0, 100)!.optimalHP, true);
  assert.equal(pokemonCaptureBallEvidence(3, 51, 100, 0, 100)!.optimalHP, true);
  assert.equal(pokemonCaptureBallEvidence(2, 35, 100, 0, 100)!.optimalHP, true);
  assert.equal(pokemonCaptureBallEvidence(4, 35, 100, 0, 100)!.chance, pokemonCaptureBallEvidence(4, 1, 100, 0, 100)!.chance);
  assert.equal(pokemonCaptureBallEvidence(4, 15, 15, 0, 255)!.plateauHP, 7);
  assert.equal(pokemonCaptureBallEvidence(4, 7, 15, 0, 255)!.chance, 1);
  assert.equal(pokemonCaptureBallEvidence(4, 3, 3, 0, 100)!.optimalHP, true);
});

test("Gen I capture estimates separate catch thresholds, status bypass and ball limits", () => {
  const poke = pokemonCaptureBallEvidence(4, 100, 100, 0, 100)!;
  assert.equal(poke.chance, 101 * 86 / 65536);
  assert.equal(pokemonCaptureBallEvidence(4, 35, 100, 0, 100)!.chance, 101 / 256);
  const asleep = pokemonCaptureBallEvidence(4, 100, 100, 1, 3)!.chance;
  const frozen = pokemonCaptureBallEvidence(4, 100, 100, 32, 3)!.chance;
  const paralyzed = pokemonCaptureBallEvidence(4, 100, 100, 64, 3)!.chance;
  assert.equal(asleep, frozen); assert.ok(asleep > paralyzed);
  assert.equal(asleep, (25 + 4 * 86 / 256) / 256);
  assert.equal(pokemonCaptureBallEvidence(1, 100, 100, 0, 3)!.chance, 1);
  assert.ok(pokemonCaptureBallEvidence(3, 100, 100, 0, 255)!.chance > pokemonCaptureBallEvidence(2, 100, 100, 0, 255)!.chance,
    "Great Balls can outperform Ultra Balls at high HP in Gen I.");
  for (const id of [2, 3, 4]) for (const status of [0, 1, 8, 16, 32, 64]) for (const rate of [0, 3, 100, 255]) {
    const current = pokemonCaptureBallEvidence(id, 900, 999, status, rate)!;
    const lowest = pokemonCaptureBallEvidence(id, 1, 999, status, rate)!;
    assert.ok(current.chance >= 0 && current.chance <= lowest.chance && lowest.chance <= 1);
  }
});

test("malformed capture data and Safari balls have no ordinary probability estimate", () => {
  for (const args of [[8, 20, 100, 0, 100], [4, 0, 100, 0, 100], [4, 101, 100, 0, 100], [4, 1, 1000, 0, 100],
    [4, 20, 100, 128, 100], [4, 20, 100, 24, 100], [4, 20, 100, 0, 256], [4, 1.5, 100, 0, 100]]) {
    assert.equal(pokemonCaptureBallEvidence(args[0]!, args[1]!, args[2]!, args[3]!, args[4]!), undefined);
  }
});

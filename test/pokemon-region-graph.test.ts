import assert from "node:assert/strict";
import { test } from "node:test";
import { cartridge, forestJourney } from "./fixtures/pokemon-world.js";

for (const yellow of [false, true]) {
  test(`${yellow ? "Yellow" : "Red/Blue"} regional distance distinguishes disconnected route areas and exact gate landing warps`, () => {
    const { graph, byte, bytes, layout, reads } = cartridge(yellow, forestJourney);
    const guidance = (map: number, x: number, y: number) => graph.guidance(map, { x, y }, 2, byte, layout, bytes.length)!;
    const gate = guidance(50, 4, 5);
    const onward = gate.exitDistance({ x: 3, y: 0, destination: 51, warp: 1 })!;
    const back = gate.exitDistance({ x: 3, y: 7, destination: 13, warp: 0 })!;
    assert.ok(onward < gate.here!); assert.ok(back > gate.here!);
    const south = guidance(13, 4, 6), north = guidance(13, 4, 1);
    assert.ok(south.here! > north.here!);
    assert.ok(south.exitDistance({ x: 3, y: 6, destination: 50, warp: 0 })! < south.here!);
    assert.ok(north.exitDistance({ x: 3, y: 1, destination: 47, warp: 1 })! > north.here!);
    assert.equal(north.exitDistance({ x: 4, y: 0, destination: 2, direction: 0 }), 0);
    const middle = guidance(51, 4, 4);
    assert.ok(middle.exitDistance({ x: 3, y: 0, destination: 47, warp: 0 })! < middle.here!);
    assert.ok(middle.exitDistance({ x: 3, y: 7, destination: 50, warp: 1 })! > middle.here!);
    const readCount = reads(); guidance(50, 4, 5); assert.equal(reads(), readCount);
    assert.equal(gate.exitDistance({ x: 3, y: 0, destination: 47, warp: 1 }), undefined);
    assert.equal(gate.exitDistance({ x: 3, y: 0, destination: 51, warp: 31 }), undefined);
    // Missing data stays unknown and reset invalidates all derived topology.
    bytes.fill(0, layout.tilesets, layout.tilesets + 24 * 12); graph.reset();
    assert.equal(graph.guidance(50, { x: 4, y: 5 }, 2, byte, layout, bytes.length), undefined);
  });
}

test("regional graph preserves one-way ledges and tile-pair barriers", () => {
  const fixture = cartridge(false, [
    { id: 60, tileset: 0, tile: (x, y) => x !== 3 ? 1 : y === 1 || y === 2 ? 2 : y === 3 ? 4 : y === 4 || y === 5 ? 0 : 1,
      warps: [[3, 1, 61, 0], [3, 5, 62, 0]] },
    { id: 61, warps: [[3, 3, 61, 0]] }, { id: 62, warps: [[3, 3, 62, 0]] },
  ]);
  const { graph, byte, bytes, layout } = fixture;
  bytes.set([0, 2, 4, 0x80, 255], layout.ledges);
  assert.ok(graph.guidance(60, { x: 3, y: 2 }, 62, byte, layout, bytes.length)!.here! > 0);
  assert.equal(graph.guidance(60, { x: 3, y: 4 }, 61, byte, layout, bytes.length)!.here, undefined);
  const barrier = cartridge(false, [
    { id: 60, tile: (_x, y) => y < 4 ? 2 : 0, warps: [[3, 1, 61, 0]] },
    { id: 61, warps: [[3, 3, 61, 0]] },
  ]);
  barrier.bytes.set([1, 2, 0, 255], barrier.layout.tilePairs);
  assert.equal(barrier.graph.guidance(60, { x: 3, y: 6 }, 61, barrier.byte, barrier.layout, barrier.bytes.length)!.here, undefined);
});

test("warp squares do not create imaginary passageways between floor regions and signed connections keep their landing offset", () => {
  const { graph, byte, bytes, layout } = cartridge(false, [
    { id: 70, tile: (x, y) => x === 3 && y !== 3 ? 1 : 0, warps: [[3, 3, 72, 0], [6, 3, 71, 0]] },
    { id: 71, warps: [[3, 3, 71, 0]] }, { id: 72, warps: [[3, 3, 72, 0]] },
    { id: 73, warps: [], connections: [[3, 70, 0, -2]] },
  ]);
  assert.equal(graph.guidance(70, { x: 1, y: 3 }, 71, byte, layout, bytes.length)!.here, undefined);
  assert.ok(graph.guidance(70, { x: 5, y: 3 }, 71, byte, layout, bytes.length)!.here! > 0);
  const edge = graph.guidance(73, { x: 7, y: 3 }, 71, byte, layout, bytes.length)!;
  assert.equal(edge.exitDistance({ x: 7, y: 1, destination: 70, direction: 3 }), undefined);
  assert.equal(edge.exitDistance({ x: 7, y: 4, destination: 70, direction: 3 }), undefined); // Lands in the separated left area.
});

test("regional hints reject unknown and unterminated tables without unbounded reads", () => {
  const { graph, byte, bytes, layout, reads } = cartridge(false, forestJourney);
  assert.equal(graph.guidance(50, { x: 4, y: 5 }, 2, byte, layout, 0), undefined);
  graph.reset(); bytes.fill(0, layout.tilePairs, layout.tilePairs + 96);
  assert.equal(graph.guidance(50, { x: 4, y: 5 }, 2, byte, layout, bytes.length), undefined);
  assert.ok(reads() < 100_000);
  graph.reset(); bytes[layout.tilePairs] = 255;
  assert.equal(graph.guidance(250, { x: 0, y: 0 }, 2, byte, layout, bytes.length), undefined);
  assert.equal(graph.guidance(50, { x: -1, y: 0 }, 2, byte, layout, bytes.length)!.here, undefined);
});

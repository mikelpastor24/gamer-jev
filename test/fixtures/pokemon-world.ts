import assert from "node:assert/strict";
import { PokemonRegionGraph } from "../../src/profiles/pokemon/region-graph.js";
import { RED_BLUE_NAVIGATION, YELLOW_NAVIGATION } from "../../src/profiles/pokemon/navigation-layout.js";

export interface MapSpec {
  readonly id: number; readonly tileset?: number;
  readonly tile?: (x: number, y: number) => number;
  readonly warps: readonly (readonly [number, number, number, number])[]; // x, y, destination, zero-based landing warp
  readonly connections?: readonly (readonly [number, number, number, number])[]; // direction, map, x alignment, y alignment
  readonly objects?: readonly { readonly picture: number; readonly trainer?: number; readonly item?: number }[];
}

/** Invented maps, block quadrants, collision lists and headers. No commercial ROM data. */
export function cartridge(yellow: boolean, maps: readonly MapSpec[]) {
  const bytes = new Uint8Array(64 * 0x4000), layout = yellow ? YELLOW_NAVIGATION : RED_BLUE_NAVIGATION;
  const pointers = yellow ? 63 * 0x4000 + 0x1f2 : 0x1ae;
  const banks = yellow ? 63 * 0x4000 + 0x3e4 : 3 * 0x4000 + 0x23d;
  const word = (offset: number, value: number) => bytes.set([value & 255, value >> 8], offset);
  const collision = yellow ? 0x7000 : 0x3000;
  for (const tileset of [0, 1, 3]) {
    bytes[layout.tilesets + tileset * 12] = 4;
    word(layout.tilesets + tileset * 12 + 1, 0x5000);
    word(layout.tilesets + tileset * 12 + 5, collision);
  }
  bytes.set([0, 2, 255], collision);
  bytes[layout.tilePairs] = 255; bytes[layout.ledges] = 255;
  for (const [index, map] of maps.entries()) {
    assert.ok(index < 16);
    bytes[banks + map.id] = 5;
    const header = 5 * 0x4000 + 0x1000 + index * 64;
    word(pointers + map.id * 2, 0x5000 + index * 64);
    bytes.set([map.tileset ?? 1, 4, 4], header); word(header + 3, 0x7000 + index * 16);
    let end = header + 10;
    for (const [direction, destination, xAlign, yAlign] of [...map.connections ?? []].sort((a, b) => a[0] - b[0])) {
      bytes[header + 9]! |= [8, 4, 2, 1][direction]!;
      bytes[end] = destination; bytes[end + 7] = yAlign & 255; bytes[end + 8] = xAlign & 255; end += 11;
    }
    word(end, 0x5800 + index * 128);
    const objects = 5 * 0x4000 + 0x1800 + index * 128;
    bytes[objects + 1] = map.warps.length;
    map.warps.forEach(([x, y, destination, warp], i) => bytes.set([y, x, warp, destination], objects + 2 + i * 4));
    let cursor = objects + 2 + map.warps.length * 4;
    bytes[cursor++] = 0; // No signs.
    bytes[cursor++] = map.objects?.length ?? 0;
    for (const sprite of map.objects ?? []) {
      bytes.set([sprite.picture, 5, 5, 0, 0, sprite.trainer ? 0x40 : sprite.item ? 0x80 : 0,
        ...(sprite.trainer ? [sprite.trainer, 1] : sprite.item ? [sprite.item] : [])], cursor);
      cursor += sprite.trainer ? 8 : sprite.item ? 7 : 6;
    }
    for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) {
      const block = index * 16 + by * 4 + bx;
      bytes[5 * 0x4000 + 0x3000 + index * 16 + by * 4 + bx] = block;
      for (let qy = 0; qy < 2; qy++) for (let qx = 0; qx < 2; qx++) {
        const tile = map.tile?.(bx * 2 + qx, by * 2 + qy) ?? 0;
        const offset = 4 * 0x4000 + 0x1000 + block * 16 + (qy * 2 + 1) * 4 + qx * 2;
        bytes[offset] = tile; bytes[offset + 1] = tile;
      }
    }
  }
  let reads = 0;
  const byte = (offset: number) => { reads++; assert.ok(offset >= 0 && offset < bytes.length); return bytes[offset]!; };
  return { bytes, layout, byte, reads: () => reads, graph: new PokemonRegionGraph() };
}

export const forestJourney: readonly MapSpec[] = [
  { id: 13, tile: (_x, y) => y === 3 || y === 4 ? 1 : 0,
    warps: [[3, 6, 50, 0], [3, 1, 47, 0]], connections: [[0, 2, 0, 7]] },
  { id: 50, warps: [[3, 7, 255, 0], [3, 0, 51, 1]] },
  { id: 51, warps: [[3, 0, 47, 1], [3, 7, 50, 1]] },
  { id: 47, warps: [[3, 0, 255, 1], [3, 7, 51, 0]] },
  { id: 2, warps: [], connections: [[1, 13, 0, 0]] },
];

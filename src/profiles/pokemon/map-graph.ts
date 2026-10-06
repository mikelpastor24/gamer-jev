import { decodeName } from "./encoding.js";

export interface PokemonMapWarp {
  readonly x: number; readonly y: number; readonly destination: number; readonly destinationWarp: number;
}
export interface PokemonMapConnection {
  readonly direction: number; readonly destination: number; readonly xAlign: number; readonly yAlign: number;
}
export interface PokemonMapData {
  readonly id: number; readonly bank: number; readonly tileset: number;
  readonly width: number; readonly height: number; readonly blocks: number;
  readonly warps: readonly PokemonMapWarp[]; readonly connections: readonly PokemonMapConnection[];
  readonly objects: readonly { readonly picture: number; readonly item?: number; readonly trainer?: string }[];
}

/** Bounded cartridge header metadata; coarse distances alone do not prove regional reachability. */
export class PokemonMapGraph {
  private edges: Map<number, Set<number>> | undefined;
  private metadata = new Map<number, PokemonMapData>();
  reset(): void { this.edges = undefined; this.metadata.clear(); }

  maps(byte: (offset: number) => number, yellow: boolean, byteLength: number): ReadonlyMap<number, PokemonMapData> {
    if (!this.edges) {
      if (byteLength < (yellow ? 64 : 4) * 0x4000) { this.edges = new Map(); return this.metadata; }
      try {
        const pointers = yellow ? 63 * 0x4000 + 0x1f2 : 0x1ae;
        const banks = yellow ? 63 * 0x4000 + 0x3e4 : 3 * 0x4000 + 0x23d;
        const edges = new Map<number, Set<number>>();
        const returns = new Set<number>();
        const word = (offset: number) => byte(offset) | byte(offset + 1) << 8;
        const address = (bank: number, pointer: number) => bank * 0x4000 + pointer - 0x4000;
        const trainers = new Map<number, string>();
        // Exact English revision symbols; retain only bounded decoded names, never cartridge assets.
        let nameStart = 14 * 0x4000 + (yellow ? 0x197e : 0x19ff);
        for (let id = 201; id <= 247; id++) {
          if (nameStart + 25 >= byteLength) break;
          const text: number[] = [];
          for (let length = 0; length <= 24; length++) { const value = byte(nameStart++); text.push(value); if (value === 0x50) break; }
          const name = decodeName(Uint8Array.from(text)); if (!name) break;
          trainers.set(id, name);
        }
        for (let id = 0; id < 248; id++) {
          const pointer = word(pointers + id * 2), bank = byte(banks + id);
          if (pointer < 0x4000 || pointer >= 0x8000 || bank < 1 || bank > 63) continue;
          const header = address(bank, pointer);
          const height = byte(header + 1), width = byte(header + 2), mask = byte(header + 9);
          if (!width || !height || width > 64 || height > 64 || mask > 15 || byte(header) >= 24) continue;
          const destinations = new Set<number>();
          const connections: PokemonMapConnection[] = [];
          let end = header + 10;
          for (const [direction, bit] of [8, 4, 2, 1].entries()) if (mask & bit) {
            const destination = byte(end); if (destination < 248) destinations.add(destination);
            const signed = (value: number) => value > 127 ? value - 256 : value;
            connections.push({ direction, destination, yAlign: signed(byte(end + 7)), xAlign: signed(byte(end + 8)) });
            end += 11;
          }
          const objects = word(end);
          if (objects < 0x4000 || objects >= 0x8000) continue;
          const start = address(bank, objects), count = byte(start + 1);
          const bankEnd = (bank + 1) * 0x4000;
          if (count > 32 || start + 2 + count * 4 >= bankEnd) continue;
          const warps: PokemonMapWarp[] = [];
          for (let warp = 0; warp < count; warp++) {
            const entry = start + 2 + warp * 4, destination = byte(entry + 3);
            warps.push({ y: byte(entry), x: byte(entry + 1), destinationWarp: byte(entry + 2), destination });
            if (destination === 255) returns.add(id);
            else if (destination < 248) destinations.add(destination);
          }
          const sprites: { picture: number; item?: number; trainer?: string }[] = [];
          // Cartridge flags distinguish actual pickups from starter balls, trainers and other sprites.
          let cursor = start + 2 + count * 4;
          const signs = byte(cursor++);
          if (signs <= 16 && cursor + signs * 3 < bankEnd) {
            cursor += signs * 3;
            const spriteCount = byte(cursor++);
            if (spriteCount <= 15 && cursor + spriteCount * 8 <= bankEnd) for (let sprite = 0; sprite < spriteCount; sprite++) {
              const flags = byte(cursor + 5);
              const trainer = flags & 0x40 ? trainers.get(byte(cursor + 6)) : undefined;
              sprites.push({ picture: byte(cursor), ...(flags & 0x80 && !(flags & 0x40) ? { item: byte(cursor + 6) } : {}), ...(trainer ? { trainer } : {}) });
              cursor += flags & 0x40 ? 8 : flags & 0x80 ? 7 : 6;
            }
          }
          edges.set(id, destinations);
          this.metadata.set(id, { id, bank, tileset: byte(header), width: width * 2, height: height * 2,
            blocks: word(header + 3), connections, warps, objects: sprites });
        }
        // LAST_MAP indoors returns to an outdoor parent; never fabricate a return for a sealed door.
        for (const [parent, destinations] of edges) if (parent < 37) for (const destination of destinations) {
          if (returns.has(destination)) edges.get(destination)?.add(parent);
        }
        this.edges = edges;
      } catch {
        // Optional topology may be absent in a synthetic cartridge or an unsupported layout.
        this.edges = new Map();
        this.metadata.clear();
      }
    }
    return this.metadata;
  }

  distance(from: number, to: number, byte: (offset: number) => number, yellow: boolean, byteLength: number): number | undefined {
    this.maps(byte, yellow, byteLength);
    const seen = new Set([from]);
    const queue = [{ map: from, distance: 0 }];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      if (current.map === to) return current.distance;
      for (const next of this.edges!.get(current.map) ?? []) if (!seen.has(next)) { seen.add(next); queue.push({ map: next, distance: current.distance + 1 }); }
    }
    return undefined;
  }
}

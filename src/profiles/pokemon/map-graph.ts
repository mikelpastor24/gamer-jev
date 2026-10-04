/** Coarse map connectivity only: does not prove regional reachability or script prerequisites. */
export class PokemonMapGraph {
  private edges: Map<number, Set<number>> | undefined;
  reset(): void { this.edges = undefined; }

  distance(from: number, to: number, byte: (offset: number) => number, yellow: boolean, byteLength: number): number | undefined {
    if (!this.edges) {
      if (byteLength < (yellow ? 64 : 4) * 0x4000) { this.edges = new Map(); return from === to ? 0 : undefined; }
      try {
        const pointers = yellow ? 63 * 0x4000 + 0x1f2 : 0x1ae;
        const banks = yellow ? 63 * 0x4000 + 0x3e4 : 3 * 0x4000 + 0x23d;
        const edges = new Map<number, Set<number>>();
        const returns = new Set<number>();
        const word = (offset: number) => byte(offset) | byte(offset + 1) << 8;
        const address = (bank: number, pointer: number) => bank * 0x4000 + pointer - 0x4000;
        for (let id = 0; id < 248; id++) {
          const pointer = word(pointers + id * 2), bank = byte(banks + id);
          if (pointer < 0x4000 || pointer >= 0x8000 || bank < 1 || bank > 63) continue;
          const header = address(bank, pointer);
          const height = byte(header + 1), width = byte(header + 2), mask = byte(header + 9);
          if (!width || !height || width > 64 || height > 64 || mask > 15 || byte(header) >= 24) continue;
          const destinations = new Set<number>();
          let end = header + 10;
          for (const bit of [8, 4, 2, 1]) if (mask & bit) {
            const destination = byte(end); if (destination < 248) destinations.add(destination); end += 11;
          }
          const objects = word(end);
          if (objects < 0x4000 || objects >= 0x8000) continue;
          const start = address(bank, objects), count = byte(start + 1);
          if (count > 32) continue;
          for (let warp = 0; warp < count; warp++) {
            const destination = byte(start + 2 + warp * 4 + 3);
            if (destination === 255) returns.add(id);
            else if (destination < 248) destinations.add(destination);
          }
          edges.set(id, destinations);
        }
        // LAST_MAP indoors returns to an outdoor parent; never fabricate a return for a sealed door.
        for (const [parent, destinations] of edges) if (parent < 37) for (const destination of destinations) {
          if (returns.has(destination)) edges.get(destination)?.add(parent);
        }
        this.edges = edges;
      } catch {
        // Optional topology may be absent in a synthetic cartridge or an unsupported layout.
        this.edges = new Map();
      }
    }
    const seen = new Set([from]);
    const queue = [{ map: from, distance: 0 }];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      if (current.map === to) return current.distance;
      for (const next of this.edges.get(current.map) ?? []) if (!seen.has(next)) { seen.add(next); queue.push({ map: next, distance: current.distance + 1 }); }
    }
    return undefined;
  }
}

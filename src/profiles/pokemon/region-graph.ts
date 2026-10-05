import { PokemonMapGraph, type PokemonMapData, type PokemonMapWarp } from "./map-graph.js";
import type { PokemonNavigationLayout } from "./navigation-layout.js";

const directions = [
  { dx: 0, dy: -1, facing: 4 }, { dx: 0, dy: 1, facing: 0 },
  { dx: -1, dy: 0, facing: 8 }, { dx: 1, dy: 0, facing: 12 },
] as const;
interface Point { readonly x: number; readonly y: number }
interface RegionMap {
  readonly data: PokemonMapData;
  readonly labels: Int32Array;
  readonly warpNodes: ReadonlyMap<number, number>;
}
export interface PokemonRegionExit extends Point {
  readonly destination: number;
  /** Zero-based cartridge warp index, or a connection direction (up/down/left/right = 0/1/2/3). */
  readonly warp?: number;
  readonly direction?: number;
}
export interface PokemonRegionalGuidance {
  readonly here: number | undefined;
  readonly exitDistance: (exit: PokemonRegionExit) => number | undefined;
}

/** Static walking areas, not a walkthrough or proof that scripts/HMs permit a journey. */
export class PokemonRegionGraph {
  private readonly headers = new PokemonMapGraph();
  private maps: Map<number, RegionMap> | undefined;
  private readonly reverse = new Map<number, Set<number>>();
  private distances = new Map<number, number>();
  private goal = "";
  private nodes = 0;
  private edges = 0;

  reset(): void {
    this.headers.reset(); this.maps = undefined; this.reverse.clear(); this.distances.clear();
    this.goal = ""; this.nodes = 0; this.edges = 0;
  }

  guidance(map: number, player: Point, goal: number, byte: (offset: number) => number,
    layout: PokemonNavigationLayout, byteLength: number): PokemonRegionalGuidance | undefined {
    return this.guidanceToAny(map, player, [goal], byte, layout, byteLength);
  }

  object(map: number, index: number, byte: (offset: number) => number, layout: PokemonNavigationLayout, byteLength: number) {
    return this.headers.maps(byte, layout.collisionBank === 1, byteLength).get(map)?.objects[index - 1];
  }

  guidanceToAny(map: number, player: Point, goals: readonly number[], byte: (offset: number) => number,
    layout: PokemonNavigationLayout, byteLength: number): PokemonRegionalGuidance | undefined {
    if (goals.length < 1 || goals.length > 4) return undefined;
    if (!this.maps) this.build(byte, layout, byteLength);
    const known = [...new Set(goals.filter(goal => this.maps!.has(goal)))].sort((a, b) => a - b);
    if (!this.maps!.has(map) || !known.length) return undefined;
    const goal = known.join(",");
    if (goal !== this.goal) {
      this.goal = goal; this.distances = new Map();
      const queue = [...new Set(known.flatMap(goal => [...this.maps!.get(goal)!.labels]))].filter(node => node >= 0);
      for (const node of queue) this.distances.set(node, 0);
      for (let head = 0; head < queue.length; head++) {
        const node = queue[head]!;
        for (const previous of this.reverse.get(node) ?? []) if (!this.distances.has(previous)) {
          this.distances.set(previous, this.distances.get(node)! + 1); queue.push(previous);
        }
      }
    }
    const distances = this.distances;
    const node = this.at(map, player);
    return { here: node === undefined ? undefined : distances.get(node), exitDistance: exit => {
      const current = this.maps!.get(map)!;
      let landing: number | undefined;
      if (exit.warp !== undefined) {
        const warp = current.data.warps[exit.warp];
        // A live LAST_MAP destination is authoritative; never treat all parts of it as interchangeable.
        if (warp && (warp.destination === exit.destination || warp.destination === 255)) {
          const destination = this.maps!.get(exit.destination);
          const target = destination?.data.warps[warp.destinationWarp];
          if (target) landing = this.at(exit.destination, target);
        }
      } else if (exit.direction !== undefined) {
        const connection = current.data.connections.find(entry => entry.direction === exit.direction && entry.destination === exit.destination);
        if (connection) landing = this.at(exit.destination, {
          x: exit.direction < 2 ? exit.x + connection.xAlign : connection.xAlign,
          y: exit.direction < 2 ? connection.yAlign : exit.y + connection.yAlign,
        });
      }
      return landing === undefined ? undefined : distances.get(landing);
    } };
  }

  private at(map: number, { x, y }: Point): number | undefined {
    const region = this.maps?.get(map);
    if (!region || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= region.data.width || y >= region.data.height) return undefined;
    const node = region.labels[y * region.data.width + x]!;
    return node < 0 ? undefined : node;
  }

  private allocate(): number {
    if (this.nodes >= 32_768) throw new Error("Regional graph node ceiling exceeded.");
    return this.nodes++;
  }
  private link(from: number | undefined, to: number | undefined): void {
    if (from === undefined || to === undefined || from === to) return;
    const incoming = this.reverse.get(to) ?? new Set<number>();
    if (!incoming.has(from)) {
      if (++this.edges > 65_536) throw new Error("Regional graph edge ceiling exceeded.");
      incoming.add(from); this.reverse.set(to, incoming);
    }
  }

  private build(readByte: (offset: number) => number, layout: PokemonNavigationLayout, byteLength: number): void {
    this.maps = new Map();
    const byte = (offset: number) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= byteLength) throw new Error("Regional table outside cartridge.");
      const value = readByte(offset);
      if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error("Invalid regional cartridge byte.");
      return value;
    };
    const word = (offset: number) => byte(offset) | byte(offset + 1) << 8;
    const address = (bank: number, pointer: number) => {
      if (pointer < 0 || pointer >= 0x8000 || bank < 0 || bank * 0x4000 >= byteLength) throw new Error("Invalid regional pointer.");
      return pointer < 0x4000 ? pointer : bank * 0x4000 + pointer - 0x4000;
    };
    const terminated = (offset: number, stride: number, ceiling: number): number[][] => {
      const entries: number[][] = [];
      for (let index = 0; index < ceiling; index += stride) {
        if (byte(offset + index) === 255) return entries;
        entries.push(Array.from({ length: stride }, (_, field) => byte(offset + index + field)));
      }
      throw new Error("Unterminated regional mechanics table.");
    };
    try {
      const metadata = this.headers.maps(byte, layout.collisionBank === 1, byteLength);
      if (!metadata.size) return;
      const pairs = terminated(layout.tilePairs, 3, 96);
      const ledges = terminated(layout.ledges, 4, 64);
      let cells = 0;
      for (const data of metadata.values()) {
        const count = data.width * data.height;
        if (count > 16_384 || cells + count > 262_144 || data.blocks < 0x4000 || data.blocks >= 0x8000) continue;
        let passable: Set<number>, tiles: Uint8Array;
        try {
          const header = layout.tilesets + data.tileset * 12;
          const bank = byte(header), blocks = word(header + 1), collision = word(header + 5);
          if (bank < 1 || bank > 63 || blocks < 0x4000 || blocks >= 0x8000 || collision === 0) continue;
          passable = new Set(terminated(address(layout.collisionBank, collision), 1, 256).map(entry => entry[0]!));
          if (!passable.size) continue;
          tiles = new Uint8Array(count);
          for (let y = 0; y < data.height; y++) for (let x = 0; x < data.width; x++) {
            const block = byte(address(data.bank, data.blocks) + (y >> 1) * (data.width >> 1) + (x >> 1));
            const tileOffset = blocks + block * 16 + ((y & 1) * 2 + 1) * 4 + (x & 1) * 2;
            if (tileOffset >= 0x8000) throw new Error("Regional block outside tileset bank.");
            tiles[y * data.width + x] = byte(address(bank, tileOffset));
          }
        } catch {
          // A single absent/corrupt map remains unknown, never a fabricated traversable region.
          continue;
        }
        cells += count;
        this.label(data, tiles, passable, pairs, ledges);
      }
      this.connect();
    } catch {
      this.maps.clear(); this.reverse.clear(); this.nodes = 0; this.edges = 0;
    }
  }

  private label(data: PokemonMapData, tiles: Uint8Array, passable: ReadonlySet<number>,
    pairs: readonly number[][], ledges: readonly number[][]): void {
    const labels = new Int32Array(tiles.length).fill(-1), warpNodes = new Map<number, number>();
    const warpSquares = new Set(data.warps.filter(warp => warp.x < data.width && warp.y < data.height).map(warp => warp.y * data.width + warp.x));
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < data.width && y < data.height;
    const pairBlocked = (a: number, b: number) => pairs.some(pair => pair[0] === data.tileset && (pair[1] === a && pair[2] === b || pair[1] === b && pair[2] === a));
    const ledge = (x: number, y: number, direction: typeof directions[number]) => data.tileset === 0 &&
      inside(x + direction.dx, y + direction.dy) && ledges.some(entry => entry[0] === direction.facing &&
        entry[1] === tiles[y * data.width + x] && entry[2] === tiles[(y + direction.dy) * data.width + x + direction.dx]);
    // Warp tiles are endpoints. They must not merge the floor areas on either side of a doorway.
    for (let start = 0; start < labels.length; start++) {
      if (labels[start] !== -1 || warpSquares.has(start) || !passable.has(tiles[start]!)) continue;
      const node = this.allocate(), queue = [start]; labels[start] = node;
      for (let head = 0; head < queue.length; head++) {
        const index = queue[head]!, x = index % data.width, y = Math.floor(index / data.width);
        for (const [dir, direction] of directions.entries()) {
          const nx = x + direction.dx, ny = y + direction.dy, next = ny * data.width + nx;
          if (!inside(nx, ny) || labels[next] !== -1 || warpSquares.has(next) || !passable.has(tiles[next]!)) continue;
          if (pairBlocked(tiles[index]!, tiles[next]!) || ledge(x, y, direction) || ledge(nx, ny, directions[dir ^ 1]!)) continue;
          labels[next] = node; queue.push(next);
        }
      }
    }
    for (const [index, warp] of data.warps.entries()) {
      if (!inside(warp.x, warp.y)) continue;
      const square = warp.y * data.width + warp.x;
      // Adjacent duplicate entries for exactly the same square share a landing node.
      const node = labels[square]! >= 0 ? labels[square]! : this.allocate();
      labels[square] = node; warpNodes.set(index, node);
    }
    this.maps!.set(data.id, { data, labels, warpNodes });
    for (const [index, warp] of data.warps.entries()) {
      const node = warpNodes.get(index);
      for (const direction of directions) {
        const x = warp.x + direction.dx, y = warp.y + direction.dy;
        if (inside(x, y) && !warpSquares.has(y * data.width + x)) this.link(node, this.at(data.id, { x, y }));
      }
    }
    for (let y = 0; y < data.height; y++) for (let x = 0; x < data.width; x++) for (const direction of directions) {
      if (!ledge(x, y, direction)) continue;
      this.link(this.at(data.id, { x, y }), this.at(data.id, { x: x + 2 * direction.dx, y: y + 2 * direction.dy }));
    }
  }

  private connect(): void {
    for (const current of this.maps!.values()) {
      for (const [index, warp] of current.data.warps.entries()) {
        const destinations: number[] = [];
        if (warp.destination !== 255) destinations.push(warp.destination);
        else {
          // LAST_MAP returns only to a matching outdoor entrance, at the recorded landing warp.
          for (const parent of this.maps!.values()) if (parent.data.id < 37 && parent.data.warps.some(entry =>
            entry.destination === current.data.id && entry.destinationWarp === index)) destinations.push(parent.data.id);
          // Paired exits may name only one entry; preserve the outdoor parent, never an indoor floor.
          if (!destinations.length) for (const parent of this.maps!.values()) if (parent.data.id < 37 &&
            parent.data.warps.some(entry => entry.destination === current.data.id)) destinations.push(parent.data.id);
        }
        for (const destination of destinations) {
          const target: PokemonMapWarp | undefined = this.maps!.get(destination)?.data.warps[warp.destinationWarp];
          if (!target) continue;
          const landing = this.at(destination, target);
          this.link(current.warpNodes.get(index), landing);
          for (const direction of directions) this.link(this.at(current.data.id,
            { x: warp.x + direction.dx, y: warp.y + direction.dy }), landing);
        }
      }
      for (const connection of current.data.connections) {
        const direction = directions[connection.direction]!;
        const length = connection.direction < 2 ? current.data.width : current.data.height;
        for (let offset = 0; offset < length; offset++) {
          const x = connection.direction < 2 ? offset : direction.dx < 0 ? 0 : current.data.width - 1;
          const y = connection.direction >= 2 ? offset : direction.dy < 0 ? 0 : current.data.height - 1;
          this.link(this.at(current.data.id, { x, y }), this.at(connection.destination, {
            x: connection.direction < 2 ? x + connection.xAlign : connection.xAlign,
            y: connection.direction < 2 ? connection.yAlign : y + connection.yAlign,
          }));
        }
      }
    }
  }
}

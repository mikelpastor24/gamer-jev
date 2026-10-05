import type { GameReaderMemory } from "../../core/game-reader.js";
import { decodeBcd, decodeName } from "./encoding.js";
import type { PokemonItemLayout } from "./item-layout.js";

/** Bounded names/prices decoded from the supplied cartridge, never a bundled asset table. */
export class PokemonItemCatalog {
  private loaded = false;
  private readonly names = new Map<number, string>();
  private readonly prices = new Map<number, number>();
  constructor(private readonly layout: PokemonItemLayout) {}
  reset(): void { this.loaded = false; this.names.clear(); this.prices.clear(); }
  load(memory: GameReaderMemory): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!memory.readRom) return;
    const read = (offset: number, length: number) => {
      try {
        if (memory.romByteLength !== undefined && offset + length > memory.romByteLength) return undefined;
        const bytes = memory.readRom!(offset, length); return bytes.length === length ? bytes : undefined;
      } catch { return undefined; }
    };
    const names = read(this.layout.names, 2048), prices = read(this.layout.prices, 83 * 3);
    if (names) {
      let start = 0;
      for (let id = 1; id <= 83; id++) {
        const end = names.indexOf(0x50, start);
        if (end < start || end - start > 24) break;
        const name = decodeName(names.subarray(start, end + 1));
        if (name && !/^\?+$/.test(name)) this.names.set(id, name);
        start = end + 1;
      }
    }
    if (prices) for (let id = 1; id <= 83; id++) {
      const price = decodeBcd(prices.subarray((id - 1) * 3, id * 3));
      if (price !== undefined && price > 0) this.prices.set(id, price);
    }
  }
  name(id: number): string | undefined {
    return id >= 0xc4 && id <= 0xc8 ? `HM${String(id - 0xc3).padStart(2, "0")}` :
      id >= 0xc9 && id <= 0xfa ? `TM${String(id - 0xc8).padStart(2, "0")}` : this.names.get(id);
  }
  price(id: number): number | undefined { return this.prices.get(id); }
}

import type { GameReaderMemory } from "../../core/game-reader.js";
import type { PokemonBattleLayout } from "./battle-layout.js";
import { decodeName } from "./encoding.js";
import { pokemonTypeNames } from "./types.js";

export interface PokemonMoveData {
  readonly name: string; readonly effect: number; readonly power: number;
  readonly type: number; readonly accuracy: number; readonly pp: number;
}
const specialEffects = new Set([0x09, 0x18, 0x1a, 0x26, 0x28, 0x29, 0x39, 0x52, 0x53]);

/** Shared bounded cartridge metadata for battle and field preparation. */
export class PokemonMoveCatalog {
  private loaded = false;
  private readonly moves = new Map<number, PokemonMoveData>();
  private chart: ReadonlyMap<string, number> | undefined;
  constructor(private readonly layout: PokemonBattleLayout) {}
  reset(): void { this.loaded = false; this.moves.clear(); this.chart = undefined; }
  move(id: number): PokemonMoveData | undefined { return this.moves.get(id); }
  standard(move: PokemonMoveData): boolean { return move.power > 1 && !specialEffects.has(move.effect); }
  get hasChart(): boolean { return this.chart !== undefined; }
  effectiveness(type: number, defenders: readonly number[]): number | undefined {
    if (!this.chart || !pokemonTypeNames[type] || !defenders.length || !defenders.every(id => pokemonTypeNames[id])) return undefined;
    return [...new Set(defenders)].reduce((factor, defender) => factor * (this.chart!.get(`${type}:${defender}`) ?? 1), 1);
  }
  maxPP(move: PokemonMoveData, packedPP: number): number { return move.pp + Math.min(7, Math.floor(move.pp / 5)) * (packedPP >> 6); }
  load(memory: GameReaderMemory): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!memory.readRom) return;
    const read = (offset: number, length: number): Uint8Array | undefined => {
      if (memory.romByteLength !== undefined && offset + length > memory.romByteLength) return undefined;
      try { const data = memory.readRom!(offset, length); return data.length === length ? data : undefined; } catch { return undefined; }
    };
    const names = read(this.layout.moveNames, 4096), records = read(this.layout.moves, 165 * 6);
    if (names && records) {
      let start = 0;
      for (let id = 1; id <= 165; id++) {
        const end = names.indexOf(0x50, start);
        if (end < start || end - start > 32) break;
        const name = decodeName(names.subarray(start, end + 1)), record = records.subarray((id - 1) * 6, id * 6);
        if (name && record[0]! > 0 && record[0]! <= 165 && pokemonTypeNames[record[3]!] && record[5]! > 0 && record[5]! <= 40) {
          this.moves.set(id, { name, effect: record[1]!, power: record[2]!, type: record[3]!, accuracy: record[4]!, pp: record[5]! });
        }
        start = end + 1;
      }
    }
    const triples = read(this.layout.typeEffects, 384), chart = new Map<string, number>();
    if (!triples) return;
    for (let offset = 0; offset + 2 < triples.length; offset += 3) {
      if (triples[offset] === 0xff) { if (chart.size) this.chart = chart; return; }
      const attack = triples[offset]!, defend = triples[offset + 1]!, factor = triples[offset + 2]!;
      const key = `${attack}:${defend}`;
      if (!pokemonTypeNames[attack] || !pokemonTypeNames[defend] || ![0, 5, 20].includes(factor) || chart.has(key)) return;
      chart.set(key, factor / 10);
    }
  }
}

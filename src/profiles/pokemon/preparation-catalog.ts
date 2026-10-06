import type { GameReaderMemory } from "../../core/game-reader.js";
import { decodeName } from "./encoding.js";
import type { PokemonPreparationLayout } from "./preparation-layout.js";
import { pokemonTypeNames } from "./types.js";

export interface PokemonSpeciesData { readonly id: number; readonly name: string; readonly types: readonly number[] }
export interface PokemonEncounter { readonly species: PokemonSpeciesData; readonly minLevel: number; readonly maxLevel: number }
export interface PokemonTrainerMon { readonly species: PokemonSpeciesData; readonly level: number }

/** Small decoded tables only. Invalid pointers, IDs and partial records stay unknown. */
export class PokemonPreparationCatalog {
  private loaded = false;
  private readonly species = new Map<number, PokemonSpeciesData>();
  private readonly encounters = new Map<number, readonly PokemonEncounter[]>();
  private readonly trainers = new Map<string, readonly PokemonTrainerMon[] | undefined>();
  constructor(private readonly layout: PokemonPreparationLayout) {
    for (const address of Object.values(layout)) if (!Number.isSafeInteger(address) || address < 0 || address >= 8 * 1024 * 1024) throw new Error("Invalid Generation I preparation layout.");
  }
  reset(): void { this.loaded = false; this.species.clear(); this.encounters.clear(); this.trainers.clear(); }
  private read(memory: GameReaderMemory, offset: number, length: number): Uint8Array | undefined {
    if (!memory.readRom || memory.romByteLength !== undefined && offset + length > memory.romByteLength) return undefined;
    try { const bytes = memory.readRom(offset, length); return bytes.length === length ? bytes : undefined; } catch { return undefined; }
  }
  private pointer(table: Uint8Array, index: number, bank: number): number | undefined {
    const pointer = table[index * 2]! | table[index * 2 + 1]! << 8;
    return pointer >= 0x4000 && pointer < 0x8000 ? bank * 0x4000 + pointer - 0x4000 : undefined;
  }
  load(memory: GameReaderMemory): void {
    if (this.loaded) return;
    this.loaded = true;
    const order = this.read(memory, this.layout.pokedexOrder, 190);
    const names = this.read(memory, this.layout.speciesNames, 190 * 10);
    const records = this.read(memory, this.layout.baseStats, (this.layout.mewStats === undefined ? 151 : 150) * 28);
    const mew = this.layout.mewStats === undefined ? undefined : this.read(memory, this.layout.mewStats, 28);
    if (order && names && records) for (let id = 1; id <= 190; id++) {
      const dex = order[id - 1]!;
      if (dex < 1 || dex > 151) continue;
      const record = dex === 151 && mew ? mew : records.subarray((dex - 1) * 28, dex * 28);
      const types = [...new Set([record[6]!, record[7]!])];
      const name = decodeName(Uint8Array.from([...names.subarray((id - 1) * 10, id * 10), 0x50]));
      if (record.length === 28 && record[0] === dex && types.every(type => pokemonTypeNames[type]) && name && !name.includes("?")) this.species.set(id, { id, name, types });
    }
    const pointers = this.read(memory, this.layout.wildPointers, 248 * 2);
    if (!pointers) return;
    const bank = Math.floor(this.layout.wildPointers / 0x4000);
    for (let map = 0; map < 248; map++) {
      const offset = this.pointer(pointers, map, bank);
      if (offset === undefined || offset % 0x4000 + 21 > 0x4000) continue;
      const bytes = this.read(memory, offset, 21);
      if (!bytes) continue;
      if (bytes[0] === 0) { this.encounters.set(map, []); continue; }
      const entries = new Map<number, PokemonEncounter>();
      let valid = true;
      for (let slot = 0; slot < 10; slot++) {
        const level = bytes[1 + slot * 2]!, species = this.species.get(bytes[2 + slot * 2]!);
        if (level < 1 || level > 100 || !species) { valid = false; break; }
        const previous = entries.get(species.id);
        entries.set(species.id, { species, minLevel: Math.min(level, previous?.minLevel ?? level), maxLevel: Math.max(level, previous?.maxLevel ?? level) });
      }
      if (valid) this.encounters.set(map, [...entries.values()]);
    }
  }
  speciesData(id: number): PokemonSpeciesData | undefined { return this.species.get(id); }
  landEncounters(map: number): readonly PokemonEncounter[] | undefined { return this.encounters.get(map); }
  ordinaryEncounterMaps(): readonly number[] { return [...this.encounters.keys()].filter(map => this.encounters.get(map)!.length > 0 && !(map >= 143 && map <= 148) && !(map >= 217 && map <= 220)); }
  trainer(memory: GameReaderMemory, trainerClass: number, partyIndex = 1): readonly PokemonTrainerMon[] | undefined {
    if (!Number.isInteger(trainerClass) || trainerClass < 1 || trainerClass > 47 || !Number.isInteger(partyIndex) || partyIndex < 1 || partyIndex > 3) return undefined;
    this.load(memory);
    const key = `${trainerClass}:${partyIndex}`;
    if (this.trainers.has(key)) return this.trainers.get(key);
    if (this.trainers.size === 16) this.trainers.delete(this.trainers.keys().next().value!);
    this.trainers.set(key, undefined);
    const pointers = this.read(memory, this.layout.trainerPointers, 47 * 2);
    const offset = pointers && this.pointer(pointers, trainerClass - 1, Math.floor(this.layout.trainerPointers / 0x4000));
    if (offset === undefined) return undefined;
    const bytes = this.read(memory, offset, Math.min(256, 0x4000 - offset % 0x4000));
    if (!bytes) return undefined;
    let cursor = 0;
    for (let party = 1; party <= partyIndex; party++) {
      const sharedLevel = bytes[cursor++], members: PokemonTrainerMon[] = [];
      if (sharedLevel === undefined || sharedLevel === 0 || sharedLevel !== 255 && sharedLevel > 100) return undefined;
      while (bytes[cursor] !== 0) {
        if (cursor >= bytes.length || members.length >= 6) return undefined;
        const level = sharedLevel === 255 ? bytes[cursor++]! : sharedLevel, species = this.species.get(bytes[cursor++]!);
        if (level < 1 || level > 100 || !species) return undefined;
        members.push({ species, level });
      }
      cursor++;
      if (!members.length) return undefined;
      if (party === partyIndex) { this.trainers.set(key, members); return members; }
    }
    return undefined;
  }
}

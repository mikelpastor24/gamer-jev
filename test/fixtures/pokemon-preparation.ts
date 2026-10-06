import type { GenerationOneLayout } from "../../src/profiles/pokemon/generation-one.js";
import { RED_BLUE_BATTLE, YELLOW_BATTLE } from "../../src/profiles/pokemon/battle-layout.js";
import { RED_BLUE_PREPARATION, YELLOW_PREPARATION } from "../../src/profiles/pokemon/preparation-layout.js";

const encode = (text: string) => [...text].map(character => character.charCodeAt(0) - 65 + 0x80);

/** Invented names, move data, teams and encounters, independent of commercial game assets. */
export function preparationTables(bytes: Uint8Array, yellow = false) {
  const layout = yellow ? YELLOW_PREPARATION : RED_BLUE_PREPARATION, battle = yellow ? YELLOW_BATTLE : RED_BLUE_BATTLE;
  const names = ["SPROUT", "COAL", "RIPPLE", "SPARK", "PEBBLE"];
  const types = [[22, 3], [20, 20], [21, 21], [23, 23], [5, 4]];
  bytes.fill(0x50, layout.speciesNames, layout.speciesNames + 190 * 10);
  names.forEach((name, index) => {
    bytes.set(encode(name), layout.speciesNames + index * 10);
    bytes[layout.pokedexOrder + index] = index + 1;
    bytes[layout.baseStats + index * 28] = index + 1;
    bytes.set(types[index]!, layout.baseStats + index * 28 + 6);
  });
  let nameOffset = battle.moveNames;
  for (let id = 1; id <= 165; id++) {
    const name = ["BURN", "LEAF", "ZAP", "VOICE"][id - 1] ?? "OTHER";
    bytes.set([...encode(name), 0x50], nameOffset); nameOffset += name.length + 1;
  }
  bytes.set([1, 0, 40, 20, 255, 15, 2, 0, 45, 22, 255, 25, 3, 0, 40, 23, 255, 30, 4, 0x12, 0, 0, 255, 40], battle.moves);
  bytes.set([20, 21, 5, 20, 5, 5, 22, 21, 20, 23, 21, 20, 0xff], battle.typeEffects);
  const trainer = (trainerClass: number, team: readonly number[]) => {
    const offset = 14 * 0x4000 + 0x3000 + (trainerClass - 29) * 64;
    const pointer = 0x4000 + offset % 0x4000;
    bytes.set([pointer & 255, pointer >> 8], layout.trainerPointers + (trainerClass - 1) * 2);
    bytes.set(team, offset);
  };
  trainer(34, [255, 12, 5, 14, 5, 0]);
  trainer(35, [255, 18, 3, yellow ? 22 : 21, 3, 0]);
  trainer(29, [10, 5, 0, 20, 5, 0, 255, 45, 5, 50, 5, 0]);
  const wild = (map: number, species = 1, level = 6) => {
    const offset = 3 * 0x4000 + 0x3000 + map * 24;
    const pointer = 0x4000 + offset % 0x4000;
    bytes.set([pointer & 255, pointer >> 8], layout.wildPointers + map * 2);
    bytes[offset] = 40;
    for (let slot = 0; slot < 10; slot++) bytes.set([level + slot % 2, species], offset + 1 + slot * 2);
  };
  wild(12); wild(14, 4, 8); wild(59, 5, 10);
  return { layout, battle, wild, trainer };
}

export function preparationParty(ram: Uint8Array, layout: GenerationOneLayout, slot = 1, id = 2, hp = 12, maxHP = 47) {
  const address = layout.partyMons + (slot - 1) * 44;
  ram.fill(0, address, address + 44);
  ram[address] = id; ram.set([hp >> 8, hp & 255], address + 1);
  ram.set(id === 2 ? [20, 20] : [22, 3], address + 5);
  ram.set([id === 2 ? 1 : 2, 4, 0, 0], address + 8);
  ram.set([id === 2 ? 15 : 25, 0xc0 | 61, 0, 0], address + 29);
  ram[address + 33] = 16; ram.set([maxHP >> 8, maxHP & 255], address + 34);
}

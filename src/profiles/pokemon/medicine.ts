import type { GenerationOneLayout } from "./generation-one.js";
import type { PokemonBattleLayout } from "./battle-layout.js";
import { decodeName } from "./encoding.js";

export interface PokemonPartyMember {
  readonly slot: number; readonly species: number; readonly name: string; readonly hp: number; readonly maxHP: number;
  readonly status: number; readonly level: number; readonly types: readonly number[];
}
export interface PokemonMedicine { readonly hp?: number; readonly status?: number }
// Mechanical item effects; names and prices remain cartridge-derived.
export function pokemonMedicine(id: number): PokemonMedicine | undefined {
  return id === 0x0b ? { status: 8 } : id === 0x10 ? { hp: 999, status: 127 } :
    id === 0x11 ? { hp: 999 } : id === 0x12 ? { hp: 200 } : id === 0x13 ? { hp: 50 } : id === 0x14 ? { hp: 20 } : undefined;
}
export function medicineBenefit(item: number, member: PokemonPartyMember): string | undefined {
  const effect = pokemonMedicine(item);
  if (!effect || member.hp === 0 || member.status > 127) return undefined;
  const hp = effect.hp ? Math.min(effect.hp, member.maxHP - member.hp) : 0;
  const status = effect.status && (member.status & effect.status) !== 0;
  if (!hp && !status) return undefined;
  return `${hp ? `restore up to ${hp} HP (${member.hp}/${member.maxHP} now)` : "no HP restoration"}${status ? "; cure the matching status" : "; no status cure"}. Does not restore PP or revive a fainted member.`;
}
/** Party identities use slots; matching active battle data overrides lagging party HP/status. */
export function pokemonPartyMembers(ram: Uint8Array, mon: GenerationOneLayout, battle: PokemonBattleLayout,
  inBattle: boolean): readonly PokemonPartyMember[] {
  const u8 = (address: number) => ram[address - 0xc000]!;
  const be = (address: number) => u8(address) * 256 + u8(address + 1);
  const count = u8(mon.partyCount), active = u8(battle.playerPartyIndex);
  if (count < 1 || count > 6) return [];
  const result: PokemonPartyMember[] = [];
  for (let slot = 0; slot < count; slot++) {
    const address = mon.partyMons + slot * 44, species = u8(address), level = u8(address + 33), maxHP = be(address + 34);
    let hp = be(address + 1), status = u8(address + 4);
    if (species < 1 || species > 190 || level < 1 || level > 100 || maxHP < 1 || maxHP > 999 || hp > maxHP || status > 127) continue;
    if (inBattle && slot === active) {
      if (u8(mon.battleMon) !== species || u8(mon.battleMon + 14) !== level || be(mon.battleMon + 15) !== maxHP ||
          be(mon.battleMon + 1) > maxHP || u8(mon.battleMon + 4) > 127) continue;
      hp = be(mon.battleMon + 1); status = u8(mon.battleMon + 4);
    }
    const name = decodeName(ram.subarray(mon.partyNicks - 0xc000 + slot * 11, mon.partyNicks - 0xc000 + (slot + 1) * 11)) ?? "unnamed";
    result.push({ slot, species, level, hp, maxHP, status, name, types: [...new Set([u8(address + 5), u8(address + 6)])] });
  }
  return result;
}

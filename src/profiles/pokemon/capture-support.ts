import type { PokemonBattleLayout } from "./battle-layout.js";
import type { GenerationOneLayout } from "./generation-one.js";
import type { PokemonMoveCatalog } from "./move-catalog.js";
import { pokemonTypeNames } from "./types.js";

interface BallEvidence {
  readonly chance: number;
  readonly hpFactor: number;
  readonly plateauHP: number;
  readonly optimalHP: boolean;
}

/** Normal eligible Gen I captures, with the cartridge's integer HP rounding. */
export function pokemonCaptureBallEvidence(ball: number, hp: number, maximum: number, status: number, rate: number): BallEvidence | undefined {
  if (![1, 2, 3, 4].includes(ball) || ![hp, maximum, status, rate].every(Number.isSafeInteger) ||
      hp < 1 || hp > maximum || maximum > 999 || rate < 0 || rate > 255 ||
      ![0, 1, 2, 3, 4, 5, 6, 7, 8, 16, 32, 64].includes(status)) return undefined;
  if (ball === 1) return { chance: 1, hpFactor: 255, plateauHP: maximum, optimalHP: true };
  const divisor = ball === 3 ? 8 : 12;
  const numerator = Math.floor(maximum * 255 / divisor);
  const bestFactor = Math.min(255, numerator);
  const hpFactor = Math.min(255, Math.floor(numerator / Math.max(1, Math.floor(hp / 4))));
  const plateauHP = Math.min(maximum, 4 * Math.floor(numerator / bestFactor) + 3);
  const outcomes = ball === 4 ? 256 : ball === 3 ? 201 : 151;
  const bonus = status === 0 ? 0 : (status & 0x27) !== 0 ? 25 : 12;
  const chance = (bonus + Math.min(rate + 1, outcomes - bonus) * (hpFactor + 1) / 256) / outcomes;
  return { chance, hpFactor, plateauHP, optimalHP: hpFactor === bestFactor };
}

export interface PokemonCapturePlan {
  readonly weaken: boolean;
  readonly reason: string;
  readonly facts: readonly string[];
  readonly moveFacts: Readonly<Record<string, readonly string[]>>;
  readonly ballFacts: Readonly<Record<number, string>>;
}

const be = (data: Uint8Array, offset: number) => data[offset]! * 256 + data[offset + 1]!;
const percent = (hp: number, max: number) => Math.round(hp * 100 / max);
const stat = (value: number) => Number.isSafeInteger(value) && value >= 1 && value <= 999;
// Only decoded, single-turn ordinary effects: exclude recoil, multi-hit, trapping,
// charging, self-KO, fixed/random/copied damage and effects that poison or burn.
const ordinaryEffects = new Set([0, 3, 5, 6, 0x10, 0x11, 0x1f, 0x24, 0x25, 0x44, 0x45, 0x46, 0x47]);

/** A read-only capture task and risk evidence. Jev still chooses every move and ball. */
export class PokemonCaptureSupport {
  constructor(private readonly layout: PokemonBattleLayout, private readonly mon: GenerationOneLayout,
    private readonly catalog: PokemonMoveCatalog) {}

  read(ram: Uint8Array, player: Uint8Array, enemy: Uint8Array, balls: readonly number[], rate: number): PokemonCapturePlan {
    const u8 = (address: number) => ram[address - 0xc000]!;
    const u16 = (address: number) => u8(address) * 256 + u8(address + 1);
    const hp = be(enemy, 1), maximum = be(enemy, 15), ballFacts: Record<number, string> = {}, moveFacts: Record<string, string[]> = {};
    const evidence = [...new Set(balls)].map(id => ({ id, data: pokemonCaptureBallEvidence(id, hp, maximum, enemy[4]!, rate) }));
    for (const { id, data } of evidence) ballFacts[id] = data ? id === 1 ?
      "Master Ball ignores HP/status for an eligible target; it is scarce, so consider preserving it when ordinary balls are available." :
      `Gen I capture estimate ~${(data.chance * 100).toFixed(1)}% per throw with current HP/status, assuming uniform random values; not a guarantee. HP benefit ${data.optimalHP ? "already maximized" : `maximizes at ${data.plateauHP}/${maximum} HP (~${percent(data.plateauHP, maximum)}%)`}.` :
      "Capture probability and HP threshold are unknown because the live capture data are invalid.";
    const facts = [
      `Capture preparation: enemy HP ${hp}/${maximum} (~${percent(hp, maximum)}%). Gen I ordinary HP benefit saturates near one third for Poke/Ultra Balls and one half for Great Balls; integer rounding can reach the plateau earlier. Going lower adds no HP benefit for a ball already at its plateau.`,
      "Sleep/freeze improve Gen I capture more than paralysis/poison/burn. Sleep/paralysis avoid residual damage; poison/burn/seed/confusion can endanger the target. Status moves do not directly lower HP. A ball attempt is not capture success.",
    ];
    const disabled = u8(this.layout.disabledMove), disabledSlot = (disabled & 15) > 0 ? disabled >> 4 : 0;
    const partySlot = u8(this.layout.playerPartyIndex), partyAddress = this.mon.partyMons + partySlot * 44;
    const criticalActor = partySlot < u8(this.mon.partyCount) && partySlot < 6 && u8(partyAddress) === player[0] &&
      u8(partyAddress + 33) === player[14] && u16(partyAddress + 34) === be(player, 15);
    const baseEnemy = u8(this.layout.enemyUnmodifiedLevel) === enemy[14] && u16(this.layout.enemyUnmodifiedStats) === maximum;
    const flags1 = u8(this.layout.enemyBattleStatus1), flags2 = u8(this.layout.enemyBattleStatus2), flags3 = u8(this.layout.enemyBattleStatus3);
    const knownTypes = [player[5]!, player[6]!, enemy[5]!, enemy[6]!].every(type => pokemonTypeNames[type]);
    let cautiousMoves = 0;
    for (let slot = 1; slot <= 4; slot++) {
      const move = this.catalog.move(player[7 + slot]!);
      if (!move || (player[24 + slot]! & 63) === 0 || disabledSlot === slot) continue;
      const id = `use_move_${slot}`, label = `Capture: ${move.name} slot ${slot}`;
      if (!this.catalog.standard(move) || !ordinaryEffects.has(move.effect)) {
        moveFacts[id] = [`${label}: ${move.power === 0 ? "no direct HP reduction" : "special, residual, multi-turn or multi-hit damage is not estimated"}. Do not treat it as a known gentle attack or repeat status moves just to lower HP.`]; continue;
      }
      const factor = knownTypes ? this.catalog.effectiveness(move.type, [enemy[5]!, enemy[6]!]) : undefined;
      if (factor === 0) { moveFacts[id] = [`${label}: ordinary type immunity; it cannot weaken this target.`]; continue; }
      const physical = move.type < 20, offset = physical ? 17 : 23, defenseOffset = physical ? 19 : 23;
      const screen = (flags3 & (physical ? 4 : 2)) !== 0;
      const attack = be(player, offset), defense = be(enemy, defenseOffset) * (screen ? 2 : 1);
      const criticalAttack = criticalActor ? u16(partyAddress + (physical ? 36 : 42)) : undefined;
      const criticalDefense = baseEnemy ? u16(this.layout.enemyUnmodifiedStats + (physical ? 4 : 8)) : undefined;
      const stab = player[5] === move.type || player[6] === move.type;
      const high = factor === undefined ? undefined : this.damage(player[14]!, move.power, attack, defense, stab, factor);
      const critical = factor === undefined || criticalAttack === undefined || criticalDefense === undefined ? undefined :
        this.damage(player[14]! * 2, move.power, criticalAttack, criticalDefense, stab, factor);
      const uncertain = flags1 !== 0 || (flags2 & 0x10) !== 0 || (flags3 & 8) !== 0;
      if (high === undefined) { moveFacts[id] = [`${label}: ordinary damage/KO risk unknown; live stats or type chart are invalid. Do not assume this attack preserves the target.`]; continue; }
      const low = Math.max(1, Math.floor(high * 217 / 255) - 2);
      const upper = Math.max(high, critical ?? high);
      const cautious = critical !== undefined && !uncertain && upper < hp && high > 0;
      if (cautious) cautiousMoves++;
      moveFacts[id] = [`${cautious ? "Priority: " : ""}${label}: approximate ordinary hit ${low}-${high} HP; critical upper estimate ${critical ?? "unknown"} HP. ` +
        (cautious ? `A hit could leave roughly ${Math.max(1, hp - upper)}-${hp - low}/${maximum} HP. Candidate for one cautious weakening attempt; reassess afterward.` :
          upper >= hp ? "KO risk: a high roll or critical could defeat the target. Prefer a ball over risking the capture." :
          "Critical/volatile risk is unknown; this is not an established cautious weakening choice.")];
    }
    const ordinary = evidence.filter(item => item.id !== 1);
    const plateau = ordinary.some(item => item.data?.optimalHP);
    const residual = (enemy[4]! & 0x18) !== 0 || (flags1 & 0x80) !== 0 || (flags2 & 0x80) !== 0;
    const urgent = be(player, 1) * 100 <= be(player, 15) * 30;
    const weaken = ordinary.some(item => item.data !== undefined) && !plateau && cautiousMoves > 0 && !residual && !urgent;
    const reason = plateau ? "An available ordinary ball already has its maximum HP benefit; do not attack further." :
      residual ? "Residual damage or confusion endangers the target; prefer a ball now instead of extra turns." :
      urgent ? "The active Pokemon has 30% HP or less; prefer a ball now instead of prolonging the battle." :
      weaken ? "Use one cautious ordinary attack to approach the available balls' HP plateau, then inspect fresh HP before another attack. Accept 30-40% or higher when another hit risks a KO." :
      "No cautious ordinary attack is established (damage/critical data may be unknown or attacks may KO). Prefer a ball at current HP; do not chase an exact percentage.";
    for (const [id, notes] of Object.entries(moveFacts)) if (!weaken && notes[0]?.startsWith("Priority:")) moveFacts[id] = [notes[0].replace("Priority: ", "") + " Prefer a ball now; further weakening is not the current capture task."];
    facts.unshift(`Priority: ${reason}`);
    return { weaken, reason, facts, moveFacts, ballFacts };
  }

  private damage(level: number, power: number, attack: number, defense: number, stab: boolean, factor: number): number | undefined {
    // The live normal stats already include stages/burn/badges. Criticals use
    // unmodified party/wild stats and doubled level, bypassing those modifiers.
    if (!stat(attack) || defense < 1 || defense > 1023 || !Number.isSafeInteger(defense)) return undefined;
    if (attack > 255 || defense > 255) { attack = Math.max(1, Math.floor(attack / 4)); defense = Math.floor(defense / 4); }
    if (!defense) return undefined;
    const base = Math.min(997, Math.floor(Math.floor((Math.floor(2 * level / 5) + 2) * power * attack / defense) / 50)) + 2;
    // Combined type factors omit intermediate rounding; round upward for risk.
    return Math.ceil((base + (stab ? Math.floor(base / 2) : 0)) * factor);
  }
}

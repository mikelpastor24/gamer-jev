import { createHash } from "node:crypto";
import type { AgentAction, GameState, StateValue } from "../../core/agent.js";
import type { GameReaderMemory, GameStateData } from "../../core/game-reader.js";
import type { GenerationOneLayout } from "./generation-one.js";
import type { PokemonBattleLayout } from "./battle-layout.js";
import type { PokemonMoveExecutionState } from "./battle-execution.js";
import { decodeName } from "./encoding.js";
import { pokemonTypeNames } from "./types.js";
import { PokemonBattleFlow } from "./battle-flow.js";

interface MoveData { readonly name: string; readonly effect: number; readonly power: number; readonly type: number; readonly accuracy: number; readonly pp: number }
interface MoveChoice { readonly slot: number; readonly id: number; readonly name: string; readonly usable: boolean; readonly summary: string; readonly explanation: string }
interface BattleSnapshot extends PokemonMoveExecutionState { readonly moves: readonly MoveChoice[]; readonly stateKey: string }

const effects: Readonly<Record<number, string>> = {
  2: "may poison", 3: "drains HP", 4: "may burn", 5: "may freeze", 6: "may paralyze", 7: "user faints",
  8: "requires a sleeping target", 0x12: "lowers Attack", 0x13: "lowers Defense", 0x16: "lowers accuracy",
  0x1d: "multiple hits", 0x20: "inflicts sleep", 0x27: "charges before attacking", 0x2a: "traps the target",
  0x2b: "two-turn airborne move", 0x30: "recoil", 0x31: "confuses", 0x38: "heals the user",
  0x40: "raises protection from special attacks", 0x41: "raises protection from physical attacks",
  0x42: "inflicts poison", 0x43: "inflicts paralysis", 0x4f: "creates a substitute using HP",
  0x50: "may require recharge", 0x54: "seeds the target", 0x55: "has no battle effect", 0x56: "disables a target move",
};
const specialEffects = new Set([0x09, 0x18, 0x1a, 0x26, 0x28, 0x29, 0x39, 0x52, 0x53]);
const factorText = (factor: number | undefined) => factor === undefined ? "unknown" : `${factor}x`;
const stateKey = (values: Readonly<Record<string, StateValue>>) => JSON.stringify([
  values.phase, values.battleKind, values.battleType, values.battlePlayer, values.battleEnemy, values.battlePlayerMoves,
  values.battleMenu, ...[1, 2, 3, 4].map(slot => values[`battleMove${slot}`]),
]);

/** Reads move properties and the Generation I chart from the user's exact cartridge. Never selects a move. */
export class PokemonBattleSupport {
  private loaded = false;
  private readonly moves = new Map<number, MoveData>();
  private chart: ReadonlyMap<string, number> | undefined;
  private snapshot: BattleSnapshot | undefined;
  private readonly flow = new PokemonBattleFlow();

  constructor(private readonly layout: PokemonBattleLayout, private readonly monLayout: GenerationOneLayout) {
    for (const [name, address] of Object.entries(layout)) if (!Number.isSafeInteger(address) ||
        (["moves", "moveNames", "typeEffects"].includes(name) ? address < 0 || address >= 8 * 1024 * 1024 : address < 0xc000 || address > 0xdfff)) {
      throw new Error("Invalid Generation I battle layout.");
    }
  }
  reset(): void { this.loaded = false; this.moves.clear(); this.chart = undefined; this.snapshot = undefined; this.flow.reset(); }
  executionState(): PokemonMoveExecutionState | undefined { return this.snapshot; }
  contextKey(state: GameState): string | undefined { return this.snapshot?.stateKey === stateKey(state.values) ? this.snapshot.context : undefined; }

  private load(memory: GameReaderMemory): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!memory.readRom) return;
    const read = (offset: number, length: number): Uint8Array | undefined => {
      if (memory.romByteLength !== undefined && offset + length > memory.romByteLength) return undefined;
      try { const data = memory.readRom!(offset, length); return data.length === length ? data : undefined; }
      catch { return undefined; }
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

  read(memory: GameReaderMemory, ram: Uint8Array, state: Readonly<Record<string, StateValue>>): GameStateData {
    this.snapshot = undefined;
    if (state.phase !== "battle" || state.battleType !== "normal") { this.flow.reset(); return { values: {}, descriptions: {} }; }
    this.load(memory);
    const u8 = (address: number) => ram[address - 0xc000]!;
    const player = ram.subarray(this.monLayout.battleMon - 0xc000, this.monLayout.battleMon - 0xc000 + 29);
    const enemy = ram.subarray(this.monLayout.enemyMon - 0xc000, this.monLayout.enemyMon - 0xc000 + 29);
    const actors = createHash("sha256").update(player).update(enemy).digest("hex").slice(0, 24);
    const tiles = ram.subarray(this.monLayout.tileMap - 0xc000, this.monLayout.tileMap - 0xc000 + 360);
    const flow = this.flow.read(tiles, state, actors);
    const validMon = (mon: Uint8Array) => mon[0]! > 0 && mon[0]! <= 190 && mon[14]! > 0 && mon[14]! <= 100 &&
      mon[15]! * 256 + mon[16]! > 0 && mon[1]! * 256 + mon[2]! <= mon[15]! * 256 + mon[16]!;
    if (!validMon(player)) return { values: {}, descriptions: {}, decisionSupport: { facts: flow.facts, actionFacts: flow.actionFacts } };
    const enemyValid = validMon(enemy), playerTypes = [...new Set([player[5]!, player[6]!])], enemyTypes = [...new Set([enemy[5]!, enemy[6]!])];
    const knownPlayerTypes = playerTypes.every(type => pokemonTypeNames[type]), knownEnemyTypes = enemyValid && enemyTypes.every(type => pokemonTypeNames[type]);
    const disabled = u8(this.layout.disabledMove), disabledSlot = (disabled & 15) > 0 ? disabled >> 4 : 0;
    const choices: MoveChoice[] = [];
    const values: Record<string, StateValue> = {}, descriptions: Record<string, string> = {}, facts: string[] = [...flow.facts], actionFacts: Record<string, readonly string[]> = { ...flow.actionFacts };
    for (let index = 0; index < 4; index++) {
      const id = player[8 + index]!, slot = index + 1, pp = player[25 + index]! & 0x3f;
      if (!id) continue;
      const data = this.moves.get(id), usable = pp > 0 && slot !== disabledSlot;
      let summary = `slot${slot}: moveId=${id}; PP=${pp}; ${slot === disabledSlot ? "disabled" : pp ? "available" : "no PP"}`, explanation = "Move metadata unavailable; do not assume its name, type, or effectiveness.";
      if (data) {
        const special = data.power === 1 || specialEffects.has(data.effect), rule = special ? "special" : data.power === 0 ? "status" : "standard";
        const category = rule === "standard" ? data.type < 20 ? "physical" : "special" : rule;
        const matchup = this.chart && knownEnemyTypes ? enemyTypes.reduce((factor, type) => factor * (this.chart!.get(`${data.type}:${type}`) ?? 1), 1) : undefined;
        const stab = knownPlayerTypes ? playerTypes.includes(data.type) ? 1.5 : 1 : undefined;
        summary = `slot${slot}: ${data.name}; id=${id}; ${pokemonTypeNames[data.type]}; ${category}; power=${data.power}; baseAccuracy~${Math.round(data.accuracy * 100 / 255)}%; PP=${pp}; ` +
          (rule === "standard" ? `STAB=${factorText(stab)}; effectiveness=${factorText(matchup)}` : rule === "status" ?
            "damageRule=status; damageEffectiveness=n/a" : `damageRule=special; typeChart=${factorText(matchup)}`) +
          (slot === disabledSlot ? "; disabled" : pp ? "" : "; no PP");
        if (effects[data.effect]) summary += `; effect=${effects[data.effect]}`;
        explanation = rule === "standard" ? `Against ${knownEnemyTypes ? enemyTypes.map(type => pokemonTypeNames[type]).join("/") : "unknown enemy types"}: ${matchup === undefined ? "type effectiveness unknown" : matchup === 0 ? "immune to this damaging type" : `${matchup}x type damage`}; ${stab === undefined ? "STAB unknown" : `${stab}x same-type attack bonus`}. These are damage factors, not a full damage prediction.` :
          rule === "status" ? "Status move: base power is zero. The damage type chart and STAB do not predict its success; consider its effect and the target's status." :
            "Special damage or copied/random move rule: base power and typeChart are not a damage estimate. STAB and ordinary type multipliers may not apply.";
        if (effects[data.effect]) explanation += ` Effect: ${effects[data.effect]}.`;
        else if (data.effect !== 0) explanation += ` Additional effectId=${data.effect}; details not decoded.`;
      }
      values[`battleMove${slot}`] = summary.slice(0, 256);
      descriptions[`battleMove${slot}`] = "Active move slot: ROM-derived name, type, Generation I damage category, power, approximate base accuracy, live PP, STAB and matchup where applicable. Accuracy excludes stat stages; damage excludes stats and other modifiers.";
      choices.push({ slot, id, name: data?.name ?? `moveId=${id}`, usable, summary: summary.slice(0, 256), explanation });
    }
    const layout = this.layout;
    const regular = choices.length > 0 && choices.every((move, index) => move.slot === index + 1 && this.moves.has(move.id)) &&
      u8(layout.moveMenuType) === 0 && u8(layout.menuY) === 12 && u8(layout.menuX) === 5 &&
      u8(layout.numMovesMinusOne) === choices.length - 1 && u8(layout.menuMax) === choices.length + 1 &&
      (u8(layout.watchedKeys) & 0xc3) === 0xc3 && u8(layout.swappingMove) === 0;
    // Battle move boxes are not always complete rectangles; validate the actual names and cursor tiles.
    const namesVisible = regular && choices.every(move => {
      const row = tiles.subarray((12 + move.slot) * 20 + 6, (12 + move.slot) * 20 + 19);
      return decodeName(Uint8Array.from([...row, 0x50])) === move.name;
    });
    const selected = u8(layout.menuItem);
    const livingActors = enemyValid && player[1]! * 256 + player[2]! > 0 && enemy[1]! * 256 + enemy[2]! > 0;
    const ready = namesVisible && livingActors &&
      selected >= 1 && selected <= choices.length && [0xec, 0xed].includes(tiles[(12 + selected) * 20 + 5]!);
    const command = /FIGHT/.test(String(state.screenTextBottom)) && /RUN/.test(String(state.screenTextBottom)) &&
      [14, 16].includes(Number(state.menuCursorY)) && [9, 15].includes(Number(state.menuCursorX));
    const menu = flow.menu ?? (ready ? "moves" : namesVisible && livingActors ? "moves_pending" : command ? "command" : "other");
    const context = flow.context ?? createHash("sha256").update(Uint8Array.from([...player, ...enemy, disabled, u8(layout.playerPartyIndex), u8(layout.enemyPartyIndex)])).digest("hex").slice(0, 24);
    values.battleMenu = menu; values.battleMoveSelection = ready ? selected : 0;
    descriptions.battleMenu = "Verified moves/command menu, moves_pending printing, faint_pending neutral transition, text_acknowledgment requiring A/B, or other/unknown battle screen. Choices are never acknowledged automatically.";
    descriptions.battleMoveSelection = "Highlighted move slot, one based; zero when the cursor and RAM selection do not agree or another screen is visible.";
    const usableSlots = choices.filter(move => move.usable).map(move => move.slot);
    this.snapshot = { menu, selectedSlot: ready ? selected : 0, context, usableSlots, moves: choices, stateKey: stateKey({ ...state, ...values }) };
    facts.push("Move types and effectiveness use this cartridge's Generation I rules. Repeated A confirms the highlighted move; it does not choose a different attack. Consider damage, PP, status effects, and the user's constraints.");
    facts.push("Base accuracy is an approximate ROM threshold, not current hit probability. Type effectiveness combines distinct enemy types; STAB applies once. Stats, stages, critical hits, burn, screens, random damage, and special effects are not estimated.");
    if (!this.chart) facts.push("The cartridge type chart is unavailable or invalid; effectiveness remains unknown.");
    if (menu === "moves") {
      facts.push("The normal attack menu is open. use_move_N navigates to exactly the chosen slot and confirms once; Jev selects the move. B returns to battle commands. UP/DOWN only change the highlight.");
      for (const move of choices) if (move.usable) actionFacts[`use_move_${move.slot}`] = [move.summary, move.explanation];
      const highlighted = choices.find(move => move.slot === selected)!;
      actionFacts.press_a = [`A confirms slot ${selected}: ${highlighted.name}. ${highlighted.usable ? "" : "This move cannot be used: no PP or disabled."}`, highlighted.summary, highlighted.explanation];
    } else if (menu === "command") {
      actionFacts.press_a = [`A confirms the highlighted battle command: ${String(state.menuCursorRow)}. FIGHT opens the move menu; it does not choose an attack yet.`];
    }
    return { values, descriptions, decisionSupport: { facts, actionFacts } };
  }

  actions(state: GameState): readonly AgentAction[] {
    if (state.values.battleMenu !== "moves" || this.contextKey(state) === undefined ||
        String(state.values.battlePlayer).includes("HP=0/") || String(state.values.battleEnemy).includes("HP=0/")) return [];
    return this.snapshot!.moves.filter(move => move.usable).map(move => ({
      id: `use_move_${move.slot}`, description: `Use slot ${move.slot}: ${move.name}. ${move.summary}. ${move.explanation} Navigate to this slot and confirm once, within 600 frames.`.slice(0, 500),
      buttons: [], frames: 600, stop: false, execution: "profile", availabilityKey: `${this.snapshot!.context}:slot${move.slot}`,
    }));
  }
  allows(state: GameState, button: string): boolean {
    if (state.values.battleMenu === "text_acknowledgment") return ["A", "B"].includes(button);
    if (state.values.battleMenu === "moves_pending") return false;
    if (state.values.battleMenu !== "moves") return true;
    if (!["A", "B", "UP", "DOWN"].includes(button)) return false;
    return button !== "A" || this.snapshot?.usableSlots.includes(Number(state.values.battleMoveSelection)) === true;
  }
}

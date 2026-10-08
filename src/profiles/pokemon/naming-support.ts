import { createHash } from "node:crypto";
import type { AgentAction, GameState, Objectives, StateValue } from "../../core/agent.js";
import type { GameStateData } from "../../core/game-reader.js";
import type { GenerationOneLayout } from "./generation-one.js";
import type { PokemonItemLayout } from "./item-layout.js";
import type { PokemonBattleLayout } from "./battle-layout.js";
import { decodeName, readTextScreen } from "./encoding.js";
import type { PokemonNamingState } from "./naming-execution.js";

/** Bounded unique-name choices, including explicit objective directives. Never chooses a name. */
export class PokemonNamingSupport {
  private suggested: readonly string[] = [];
  private readonly observed = new Set<string>();
  private snapshot: PokemonNamingState | undefined;
  constructor(private readonly mon: GenerationOneLayout, private readonly items: PokemonItemLayout, private readonly menu: PokemonBattleLayout) {}
  reset(): void { this.observed.clear(); this.snapshot = undefined; }
  setObjectives(objectives: Objectives): void {
    const supplied = [objectives.goal, ...objectives.constraints, ...objectives.milestones].flatMap(text =>
      [...text.matchAll(/^\s*Pokemon names:\s*([A-Za-z ,]+)\s*\.?$/gmi)].flatMap(match => match[1]!.split(",").map(name => name.trim().toUpperCase())));
    this.suggested = [...new Set(supplied.filter(name => /^[A-Z]{1,10}$/.test(name)))].slice(0, 16);
    this.snapshot = undefined;
  }
  executionState(): PokemonNamingState | undefined { return this.snapshot; }
  read(ram: Uint8Array, values: Readonly<Record<string, StateValue>>): GameStateData {
    this.snapshot = undefined;
    const u8 = (address: number) => ram[address - 0xc000]!;
    const live = new Set<string>();
    const remember = (address: number) => {
      const name = decodeName(ram.subarray(address - 0xc000, address - 0xc000 + 11))?.toUpperCase();
      if (!name) return;
      live.add(name);
      if (this.observed.has(name)) return;
      if (this.observed.size >= 32) this.observed.delete(this.observed.values().next().value!);
      this.observed.add(name);
    };
    if (values.gameStarted === true) {
      if (u8(this.mon.partyCount) <= 6) for (let slot = 0; slot < u8(this.mon.partyCount); slot++) remember(this.mon.partyNicks + slot * 11);
      if (u8(this.items.boxCount) <= 20) for (let slot = 0; slot < u8(this.items.boxCount); slot++) remember(this.items.boxNicks + slot * 11);
    }
    if (values.phase !== "naming") return { values: {}, descriptions: {} };
    const tiles = ram.subarray(this.mon.tileMap - 0xc000, this.mon.tileMap - 0xc000 + 360), screen = readTextScreen(tiles);
    const type = u8(this.items.menuType), length = u8(this.items.nameLength), row = u8(this.menu.menuItem), x = u8(this.menu.menuX);
    const buffer = ram.subarray(this.items.stringBuffer - 0xc000, this.items.stringBuffer - 0xc000 + 11);
    const decoded = decodeName(buffer), entered = decoded ?? "";
    const maximum = type === 2 ? 10 : 7;
    const reserved = new Set([...live, ...this.observed]);
    const valid = screen.naming && (decoded !== undefined || buffer[0] === 0x50) && type <= 2 && length === entered.length && length <= maximum &&
      u8(this.items.submitName) === 0 && row >= 1 && row <= 6 && x >= 1 && x <= 17 && x % 2 === 1 &&
      tiles[(3 + row * 2) * 20 + x] === 0xed;
    if (!valid) return { values: {}, descriptions: {}, decisionSupport: { facts: ["The naming grid is present but its buffer/cursor are not verified yet. Do not infer a completed name from repeated A."], actionFacts: {} } };
    const duplicate = type === 2 && reserved.has(entered.toUpperCase());
    const raw = type === 2 ? String(values.namingPrompt ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10) : type === 0 ? "JEV" : "RIVAL";
    const base = raw || "BUDDY", names: string[] = [];
    const add = (name: string) => { if (/^[A-Z]+$/.test(name) && name.length <= maximum && !names.includes(name) &&
      (type !== 2 || !reserved.has(name))) names.push(name); };
    if (type === 2) for (const name of this.suggested) add(name);
    add(base);
    for (let index = 0; index < 90 && names.length < 4; index++) {
      const pair = index - 26;
      const suffix = index < 26 ? String.fromCharCode(65 + index) :
        String.fromCharCode(65 + Math.floor(pair / 26)) + String.fromCharCode(65 + pair % 26);
      add(base.slice(0, maximum - suffix.length) + suffix);
    }
    const offered = names.slice(0, 4), context = createHash("sha256").update(JSON.stringify([type, values.namingPrompt, offered])).digest("hex").slice(0, 24);
    this.snapshot = { context, entered, x, row, upper: tiles[5 * 20 + 2] === 0x80, names: offered };
    const facts = [
      `Naming ${type === 2 ? "a Pokemon" : type === 0 ? "the player" : "the rival"}: current entry '${entered || "empty"}', maximum ${maximum} characters. Full-name actions type exactly one Jev-selected name and submit it once; repeated A types the same highlighted letter.`,
      ...(type === 2 ? [`Known reserved names: ${[...reserved].join(", ").slice(0, 280) || "none"}. Offered names avoid case-insensitive duplicates in the known party, current box and up to 32 recently observed names; unseen PC boxes remain unknown.`] : []),
      ...(duplicate ? ["Priority: this entry repeats a known Pokemon name. Prefer an offered unique name so party members are easier to distinguish."] : []),
    ];
    const actionFacts = { press_a: [`A appends the highlighted grid character; repeatedly selecting it does not choose a meaningful whole name. Prefer a full-name action. Current entry '${entered}'.`],
      press_start: [`START submits '${entered || "empty"}'. ${duplicate ? "This duplicates a known name; prefer a unique offered name." : "Use a distinct name when naming a Pokemon."}`] };
    return { values: { enteredName: entered, namingKind: type === 2 ? "pokemon" : type === 0 ? "player" : "rival" },
      descriptions: { enteredName: "Verified naming buffer, including an empty entry; grid confirmations use one frame.", namingKind: "Exact naming-screen type matched to the visible alphabet and live buffer/cursor." },
      decisionSupport: { facts, actionFacts, decisionGoal: `Choose one offered full-name action for ${type === 2 ? "this Pokemon" : type === 0 ? "the player" : "the rival"}. ${type === 2 ? "Use a unique name; explicit 'Pokemon names:' objective suggestions appear when valid and unused." : "Player/rival names have a seven-character limit."} Do not repeatedly press A on one letter. Supplied constraints remain authoritative.` } };
  }
  actions(state: GameState): readonly AgentAction[] {
    if (state.values.phase !== "naming" || !this.snapshot) return [];
    return this.snapshot.names.map((name, index) => ({ id: `name_option_${index + 1}`, description: `Priority: assign the complete ${state.values.namingKind === "pokemon" ? "unique Pokemon " : ""}name '${name}'. Replace the current entry with exactly this offered name, then submit once. Each grid key is confirmed separately; no other name is selected.`,
      buttons: [], frames: 600, stop: false, execution: "profile", availabilityKey: `${this.snapshot!.context}:${name}` }));
  }
  chosenName(id: string): string | undefined { return /^name_option_[1-4]$/.test(id) ? this.snapshot?.names[Number(id.slice(12)) - 1] : undefined; }
}

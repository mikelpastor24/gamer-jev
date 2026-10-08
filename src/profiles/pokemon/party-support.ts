import { createHash } from "node:crypto";
import type { AgentAction, GameActionExecution, GameState, StateValue } from "../../core/agent.js";
import type { GameReaderMemory, GameStateData } from "../../core/game-reader.js";
import type { GenerationOneLayout } from "./generation-one.js";
import type { PokemonBattleLayout } from "./battle-layout.js";
import type { PokemonItemLayout } from "./item-layout.js";
import type { PokemonItemCatalog } from "./item-catalog.js";
import { decodeName } from "./encoding.js";
import { medicineBenefit, pokemonMedicine, pokemonPartyMembers } from "./medicine.js";

interface PartySnapshot {
  readonly context: string; readonly kind: "switch" | "medicine" | "inspect" | "confirm";
  readonly selected: number; readonly choices: readonly { readonly slot: number; readonly description: string; readonly id: string }[];
  readonly allowA: boolean;
  readonly allowB: boolean;
}

/** Recognizes unboxed party rows by position, even when nicknames are identical. */
export class PokemonPartySupport {
  private snapshot: PartySnapshot | undefined;
  private medicinePending = false;
  constructor(private readonly mon: GenerationOneLayout, private readonly menu: PokemonBattleLayout,
    private readonly items: PokemonItemLayout, private readonly catalog: PokemonItemCatalog) {}
  reset(): void { this.snapshot = undefined; this.medicinePending = false; }
  pending(): boolean { return this.medicinePending; }
  battlePartyOpen(): boolean { return this.snapshot?.kind === "switch" || this.snapshot?.kind === "confirm"; }
  contextKey(): string { return this.snapshot ? `${this.snapshot.context}:${this.snapshot.selected}` : ""; }
  read(memory: GameReaderMemory, ram: Uint8Array, state: Readonly<Record<string, StateValue>>): GameStateData {
    this.snapshot = undefined;
    this.medicinePending = false;
    if (state.gameStarted !== true || ["naming", "transition"].includes(String(state.phase))) return { values: {}, descriptions: {} };
    if (state.phase === "battle" && state.battleType !== "normal") return { values: {}, descriptions: {} };
    this.catalog.load(memory);
    const u8 = (address: number) => ram[address - 0xc000]!;
    const tiles = ram.subarray(this.mon.tileMap - 0xc000, this.mon.tileMap - 0xc000 + 360);
    const text = (row: number, x: number, length: number) => decodeName(Uint8Array.from([...tiles.subarray(row * 20 + x, row * 20 + x + length), 0x50]));
    const inBattle = state.phase === "battle" && state.battleType === "normal";
    const count = u8(this.mon.partyCount), members = pokemonPartyMembers(ram, this.mon, this.menu, inBattle);
    if (members.length !== count || count < 1 || count > 6) return { values: {}, descriptions: {} };
    const selected = u8(this.menu.menuItem), active = u8(this.menu.playerPartyIndex), kind = u8(this.items.menuType);
    const namesVisible = members.every(member => member.name !== "unnamed" && text(member.slot * 2, 3, 10) === member.name);
    const list = namesVisible && u8(this.menu.menuY) === 1 && u8(this.menu.menuX) === 0 &&
      u8(this.menu.menuMax) === count - 1 && (u8(this.menu.watchedKeys) & 1) !== 0 && u8(this.items.monDataLocation) === 0 &&
      u8(this.menu.swappingMove) === 0 && selected < count && tiles[(1 + selected * 2) * 20] === 0xed && [0, 1, 2].includes(kind);
    const confirmation = inBattle && active < count && text(12, 13, 6) === "SWITCH" && text(14, 13, 5) === "STATS" && text(16, 13, 6) === "CANCEL" &&
      u8(this.menu.menuY) === 12 && u8(this.menu.menuX) === 12 && u8(this.menu.menuMax) === 2 && selected <= 2 &&
      tiles[(12 + selected * 2) * 20 + 12] === 0xed && (u8(this.menu.watchedKeys) & 3) === 3;
    const slot = u8(this.items.whichPokemon), savedBagCursor = u8(this.items.bagSaved), scroll = u8(this.items.scroll),
      bagSlot = savedBagCursor + scroll, bagCount = u8(this.mon.bagCount);
    const bagItems = bagCount <= 20 ? Array.from({ length: bagCount }, (_, index) => u8(this.mon.bagItems + index * 2)) : [];
    const bagValid = bagCount >= 1 && bagCount <= 20 && u8(this.mon.bagItems + bagCount * 2) === 0xff &&
      new Set(bagItems).size === bagCount && bagItems.every((id, index) => id > 0 && id < 255 &&
        u8(this.mon.bagItems + index * 2 + 1) >= 1 && u8(this.mon.bagItems + index * 2 + 1) <= 99);
    const bagPointer = (u8(this.items.listPointer) | u8(this.items.listPointer + 1) << 8) === this.mon.bagCount;
    const medicine = kind === 1 && bagValid && bagPointer && savedBagCursor <= 2 && bagSlot < bagCount &&
      u8(this.items.pseudoItem) === 0 ? bagItems[bagSlot] : undefined;
    const medicineName = medicine === undefined ? undefined : this.catalog.name(medicine);
    const knownSelection = medicine !== undefined && pokemonMedicine(medicine) !== undefined && medicineName !== undefined;
    // Party drawing reuses wListMenuID as HP-bar type 2, wCurItem as species,
    // and wStringBuffer as SGB packet data. The saved bag row and inventory remain authoritative.
    const medicineKnown = list && knownSelection && u8(this.items.listId) === 2;
    const promptReady = /Use item on which\s+POK.MON\?/.test(String(state.screenTextBottom));
    const blankBattle = inBattle && state.screenTextTop === "" && state.screenTextBottom === "" &&
      !tiles.includes(0xed) && !tiles.includes(0xec);
    if (knownSelection && !confirmation && (blankBattle && [2, 3].includes(u8(this.items.listId)) || list && !promptReady)) {
      this.medicinePending = true;
      return { values: { ...(inBattle ? { battleMenu: "party" } : { phase: "menu" }), partyMenuKind: "medicine_pending" },
        descriptions: { partyMenuKind: "The selected medicine's party selector is still drawing or printing; input readiness is not verified." },
        decisionSupport: { facts: ["The selected medicine's party target screen is still drawing or printing. Settle locally with buttons released for at most 600 frames; no recipient or acknowledgment is selected automatically."],
          actionFacts: {}, decisionGoal: "Wait for the selected medicine's party rows and complete input prompt, then let Jev choose a beneficial slot. Opening the selector has not healed anyone." } };
    }
    if (!list && !confirmation) return { values: {}, descriptions: {} };
    const choices: PartySnapshot["choices"][number][] = [], facts: string[] = [], actionFacts: Record<string, string[]> = {};
    const partyKind: PartySnapshot["kind"] = confirmation ? "confirm" : kind === 1 ? "medicine" : inBattle ? "switch" : "inspect";
    const context = createHash("sha256").update(JSON.stringify([partyKind, state.mapId, members, active, medicineKnown ? medicine : "unknown",
      ...(medicineKnown ? Array.from(ram.subarray(this.mon.bagCount - 0xc000, this.mon.bagItems - 0xc000 + bagCount * 2)) : []),
      ...(confirmation ? [slot] : []), ...(inBattle ? [state.battleEnemy] : [])])).digest("hex").slice(0, 24);
    let allowA = true;
    if (confirmation) {
      const target = members.find(member => member.slot === slot), usable = target && target.hp > 0 && slot !== active;
      if (usable) choices.push({ slot: 0, id: `confirm_switch_to_slot_${slot + 1}`, description: `Confirm SWITCH to party slot ${slot + 1}: '${target.name}', speciesId=${target.species}, Lv${target.level}, HP=${target.hp}/${target.maxHP}. This is a different living member from active slot ${active + 1}. Navigate to SWITCH and confirm once; no alternate member is selected.` });
      allowA = selected !== 0 || Boolean(usable);
      facts.push(`Battle switch confirmation belongs to party slot ${slot + 1}, not just its nickname. Active slot ${active + 1}. ${usable ? "Jev must separately choose SWITCH." : "This selection is already active, fainted or unknown; do not repeat SWITCH on it. B returns to the party list."}`);
      actionFacts.press_a = [`A selects ${["SWITCH", "STATS", "CANCEL"][selected]} for party slot ${slot + 1}.`];
    } else {
      if (medicineKnown) facts.push(`Selected medicine: ${medicineName} from saved bag slot ${bagSlot + 1}, quantity ${u8(this.mon.bagItems + bagSlot * 2 + 1)}. The party HP-bar and species/name buffers do not identify the selected item.`);
      facts.push(`Verified ${partyKind} party menu. Cursor highlights slot ${selected + 1}; nickname alone does not identify a member. ${inBattle ? `Active battle slot ${active + 1}.` : "Outside battle, selecting a member opens its menu."} Each row has a fixed slot even when names repeat.`);
      for (const member of members) {
        const benefit = medicineKnown ? medicineBenefit(medicine!, member) : undefined;
        const usable = partyKind === "medicine" ? benefit !== undefined : partyKind === "switch" ? active < count && member.slot !== active && member.hp > 0 : true;
        const label = `party slot ${member.slot + 1}: '${member.name}', speciesId=${member.species}, Lv${member.level}, HP=${member.hp}/${member.maxHP}, statusByte=${member.status}`;
        facts.push(`${label}${inBattle && member.slot === active ? "; currently active" : ""}. ${benefit ?? (partyKind === "medicine" ? "No verified benefit from the selected medicine." : "Use the slot to distinguish this Pokemon.")}`);
        if (usable) choices.push({ slot: member.slot, id: `${partyKind === "medicine" ? "apply_medicine_to" : "select_party"}_slot_${member.slot + 1}`,
          description: `${partyKind === "medicine" ? "Priority: apply " + this.catalog.name(medicine!) + " to " : "Select "}${label}. ${benefit ?? (partyKind === "switch" ? "This chooses a different living member; a voluntary switch may open a separate SWITCH confirmation." : "Open this member's menu.")} Navigate to exactly this row and confirm once; never substitute a target.` });
      }
      allowA = choices.some(choice => choice.slot === selected);
      if (partyKind === "medicine" && !medicineKnown) { allowA = true; facts.push("The medicine identity is not verified from the saved bag row, stock, item catalog and party context. B cancels; bounded controller attempts remain, but no named treatment is inferred."); }
      actionFacts.press_a = [`A selects party slot ${selected + 1}: '${members[selected]!.name}'. ${allowA ? "Confirm once and reassess." : "This member is already active, fainted or receives no verified medicine benefit; choose another row."}`];
      if (partyKind === "medicine") actionFacts.press_b = ["B cancels this treatment without consuming medicine or restoring HP/status. Choose a beneficial apply_medicine action to treat a member when offered."];
    }
    const forced = inBattle && (members.find(member => member.slot === active)?.hp === 0 || (u8(this.menu.watchedKeys) & 2) === 0);
    const medicineGoal = !medicineKnown ? "Choose a verified beneficial medicine target by party slot. Item identity is unknown; cancel to choose a known medicine again when possible." :
      choices.length ? `Choose a verified beneficial medicine target by party slot. The selected item is ${medicineName}; selecting a valid row uses one item. B cancels without healing. Inspect HP/status and inventory afterward.` :
        `The selected ${medicineName} has no verified beneficial target. B cancels without using it; leave this treatment rather than repeatedly applying an ineffective item.`;
    this.snapshot = { context, kind: partyKind, selected, choices, allowA, allowB: (u8(this.menu.watchedKeys) & 2) !== 0 };
    return { values: { ...(inBattle ? { battleMenu: "party" } : { phase: "menu" }), partyMenuKind: partyKind, partySelection: selected + 1,
        ...(medicineKnown ? { partyMedicine: `${medicineName}; bag slot ${bagSlot + 1}; quantity ${u8(this.mon.bagItems + bagSlot * 2 + 1)}` } : {}) },
      descriptions: { ...(inBattle ? { battleMenu: "Verified party list or SWITCH confirmation, independently of move/text menus." } : { phase: "Verified party menu; unboxed nickname rows and RAM cursor agree." }),
        partyMenuKind: "Verified party context; members are identified by slot, species and HP rather than nickname alone.", partySelection: "Highlighted party row (or switch-command row), one based.",
        ...(medicineKnown ? { partyMedicine: "Verified medicine and stock from the saved bag row; party drawing reuses the item ID, list ID and string buffers." } : {}) },
      decisionSupport: { facts, actionFacts, decisionGoal: partyKind === "medicine" ? medicineGoal :
        inBattle ? `Resolve this party choice by party slot, species, level, HP and moves. ${forced ? "A living replacement is required." : "Switching is optional here; B cancels when allowed, which can preserve a stronger active member."} Do not select the already active or fainted member. Repeated nicknames do not identify the same member; confirm SWITCH separately when offered.` : "Select the intended party member by slot, species and HP; duplicate nicknames do not change row identity." } };
  }
  actions(): readonly AgentAction[] {
    return this.snapshot?.choices.map(choice => ({ id: choice.id, description: choice.description.slice(0, 500), buttons: [], frames: 600,
      execution: "profile", stop: false, availabilityKey: `${this.snapshot!.context}:${choice.id}` })) ?? [];
  }
  allows(button: string): boolean { return !this.snapshot || ["A", "B", "UP", "DOWN"].includes(button) &&
    (button !== "A" || this.snapshot.allowA) && (button !== "B" || this.snapshot.allowB); }
  execution(id: string, read: () => void): GameActionExecution | undefined {
    const initial = this.snapshot, target = initial?.choices.find(choice => choice.id === id);
    if (!initial || !target) return undefined;
    let frames = 0, release = 0, confirmed = false;
    return { next: () => {
      if (++frames > 600) return { done: true, reason: "Party action reached its frame ceiling." };
      if (confirmed) return { done: true, reason: "Selected party-row confirmation sent once; inspect its result." };
      read(); const state = this.snapshot;
      if (!state || state.context !== initial.context || !state.choices.some(choice => choice.id === id)) return { done: true, reason: "Party, medicine or battle context changed; no alternate member selected." };
      if (release) { release--; return { done: false, buttons: [] }; }
      const button = state.selected === target.slot ? "A" : state.selected < target.slot ? "DOWN" : "UP";
      confirmed = button === "A"; release = 6;
      return { done: false, buttons: [button] };
    } };
  }
}

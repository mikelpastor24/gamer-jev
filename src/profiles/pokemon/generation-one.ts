import type { AgentAction, GameState, Objectives, StateValue } from "../../core/agent.js";
import type { GameReader, GameReaderDescriptor, GameReaderMemory, GameStateData } from "../../core/game-reader.js";
import { countBits, decodeBcd, decodeName, readTextScreen } from "./encoding.js";
import { GenerationOneDecisionSupport } from "./decision-support.js";
import type { PokemonNavigationLayout } from "./navigation-layout.js";
import { pokemonNavigationExecution } from "./navigation-execution.js";
import type { PokemonBattleLayout } from "./battle-layout.js";
import { PokemonBattleSupport } from "./battle-support.js";
import { pokemonMoveExecution } from "./battle-execution.js";
import { pokemonTypeNames } from "./types.js";

/** Addresses vary by engine, language, and revision. This contract is only for English Gen I. */
export interface GenerationOneLayout {
  readonly tileMap: number;
  readonly playerName: number;
  readonly rivalName: number;
  readonly partyCount: number;
  readonly partyMons: number;
  readonly partyNicks: number;
  readonly pokedexOwned: number;
  readonly pokedexSeen: number;
  readonly bagCount: number;
  readonly bagItems: number;
  readonly money: number;
  readonly badges: number;
  readonly mapId: number;
  readonly mapY: number;
  readonly mapX: number;
  readonly mapHeight: number;
  readonly mapWidth: number;
  readonly facing: number;
  readonly movementMode: number;
  readonly statusFlags5: number;
  readonly statusFlags6: number;
  readonly battleKind: number;
  readonly battleType: number;
  readonly battleMon: number;
  readonly battleNick: number;
  readonly enemyMon: number;
  readonly enemyNick: number;
  readonly fontLoaded: number;
}

const badgeNames = ["Boulder", "Cascade", "Thunder", "Rainbow", "Soul", "Marsh", "Volcano", "Earth"];

function status(value: number, hp: number): string {
  if (hp === 0) return "fainted";
  const effects: string[] = [];
  if (value & 7) effects.push(`sleep(${value & 7})`);
  for (const [mask, name] of [[8, "poison"], [16, "burn"], [32, "freeze"], [64, "paralysis"]] as const) if (value & mask) effects.push(name);
  return effects.join(",") || "healthy";
}

function menuLabel(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/^>\s*/, "").trim().toUpperCase();
}

/** Shared Gen I decoding with profile-local story evidence and target execution. No model calls. */
export class GenerationOnePokemonReader implements GameReader {
  readonly descriptor: GameReaderDescriptor;
  private readonly layout: GenerationOneLayout;
  private readonly support: GenerationOneDecisionSupport;
  private readonly combat: PokemonBattleSupport | undefined;
  private pulseFrames = 8;
  private controlMap: number | undefined;
  private mapChangedAt = -60;

  constructor(descriptor: GameReaderDescriptor, layout: GenerationOneLayout, navigation?: PokemonNavigationLayout, readonly defaultObjectives?: Objectives, battle?: PokemonBattleLayout) {
    this.descriptor = structuredClone(descriptor);
    this.layout = { ...layout };
    this.support = new GenerationOneDecisionSupport(navigation);
    this.combat = battle ? new PokemonBattleSupport({ ...battle }, this.layout) : undefined;
    for (const address of Object.values(layout)) if (!Number.isSafeInteger(address) || address < 0xc000 || address > 0xdfff) {
      throw new Error("Generation I layout addresses must be in Game Boy work RAM.");
    }
  }

  reset(): void { this.support.reset(); this.combat?.reset(); this.controlMap = undefined; this.mapChangedAt = -60; }
  setObjectives(objectives: Objectives): void { this.support.setObjectives(objectives); }
  shouldWait(state: GameStateData, frame: number): boolean {
    if (typeof state.values.mapId === "number" && state.values.gameStarted === true) {
      if (this.controlMap !== undefined && this.controlMap !== state.values.mapId) this.mapChangedAt = frame;
      this.controlMap = state.values.mapId;
    }
    return state.values.gameStarted === true && (state.values.phase === "transition" || state.values.battleMenu === "moves_pending" || state.values.movementInProgress === true || state.values.controlBusy === true ||
      state.values.phase === "overworld" && frame - this.mapChangedAt < 60);
  }
  createExecution(memory: GameReaderMemory, action: AgentAction) {
    if (action.execution !== "profile") throw new Error("Only offered profile actions have local executors.");
    if (/^use_move_[1-4]$/.test(action.id) && this.combat) return pokemonMoveExecution(Number(action.id.at(-1)), () => {
      this.readState(memory);
      return this.combat!.executionState();
    }, this.pulseFrames);
    return pokemonNavigationExecution(action.id, () => {
      const state = this.readState(memory);
      return { state, route: this.support.route(action.id) };
    }, this.pulseFrames, (target, outcome) => this.support.remember(target, outcome));
  }

  readState(memory: GameReaderMemory): GameStateData {
    const ram = memory.readMemory(0xc000, 0x2000);
    const bytes = (address: number, length: number) => {
      if (address < 0xc000 || address + length > 0xe000) throw new Error("Generation I layout read exceeds work RAM.");
      return ram.subarray(address - 0xc000, address - 0xc000 + length);
    };
    const byte = (address: number) => bytes(address, 1)[0]!;
    const layout = this.layout;
    const lcdEnabled = (memory.readMemory(0xff40, 1)[0]! & 0x80) !== 0;
    const screen = readTextScreen(lcdEnabled ? bytes(layout.tileMap, 360) : new Uint8Array(360));
    const playerName = decodeName(bytes(layout.playerName, 11));
    const started = (byte(layout.statusFlags6) & 1) !== 0 && playerName !== undefined;
    const battle = started ? byte(layout.battleKind) : 0;
    const inBattle = battle === 1 || battle === 2;
    // Bit 5 blocks overworld joypad handling. Naming screens also set it while accepting menu keys.
    const inputBlocked = started && !inBattle && !screen.hasBox && (byte(layout.statusFlags5) & 0x20) !== 0;
    const phase = !lcdEnabled || inputBlocked ? "transition" : inBattle ? "battle" : screen.naming ? "naming" : screen.cursor ? "menu" :
      screen.hasBox ? "text" : started ? "overworld" : "boot_or_intro";
    const values: Record<string, StateValue> = {};
    const descriptions: Record<string, string> = {};
    const inventory = started && byte(layout.bagCount) <= 20 ? Array.from({ length: byte(layout.bagCount) },
      (_, slot) => byte(layout.bagItems + slot * 2 + 1) > 0 ? byte(layout.bagItems + slot * 2) : 0) : [];
    const add = (name: string, value: StateValue, description: string) => { values[name] = value; descriptions[name] = description; };
    const enriched = (): GameStateData => {
      const extra = this.support.read(memory, ram, values, inventory);
      const combat = this.combat?.read(memory, ram, values);
      const support = combat?.decisionSupport ?? extra.decisionSupport;
      return { values: { ...values, ...extra.values, ...combat?.values }, descriptions: { ...descriptions, ...extra.descriptions, ...combat?.descriptions },
        ...(support ? { decisionSupport: { facts: [...(combat?.decisionSupport?.facts ?? []), ...(extra.decisionSupport?.facts ?? [])].slice(0, 32),
          actionFacts: { ...extra.decisionSupport?.actionFacts, ...combat?.decisionSupport?.actionFacts } } } : {}) };
    };
    add("phase", phase, "Memory evidence: menu has a visible box cursor; text has a box; battle uses the battle flag. Boot, intro, and transitions may need waiting.");
    add("gameStarted", started, "The game timer is enabled and a terminated player name exists. Introductory map defaults are not exploration state.");
    add("screenTextTop", screen.top, "Text inside complete memory tile-map boxes in rows 0-8; > marks a cursor. May be partially printed; clipped to 256 characters.");
    add("screenTextBottom", screen.bottom, "Text inside complete memory tile-map boxes in rows 9-17; v can be a continuation marker. May be partially printed; clipped to 256 characters.");
    if (started && !inBattle) add("dialogueActive", screen.dialogueBox && (byte(layout.fontLoaded) & 1) !== 0,
      "The complete bottom dialogue box is present and the overworld font is loaded. A closed dialogue must not be reopened by an input intended to advance it.");
    if (screen.cursor) {
      add("menuCursorX", screen.cursor.x, "Visible cursor tile column, zero based. This does not assert that the game is polling input yet.");
      add("menuCursorY", screen.cursor.y, "Visible cursor tile row, zero based.");
      add("menuCursorRow", screen.cursor.row.slice(0, 256), "Text on the visible cursor row. Two-column menus and naming grids can contain several choices on one row.");
    }
    if (screen.naming) {
      add("namingPrompt", screen.naming.prompt, "Naming-screen heading, decoded only when its alphabet grid is present.");
      add("enteredName", screen.naming.name, "Current naming entry. A appends a selected character, B deletes, SELECT switches case, and START finishes a nonempty name.");
    }
    if (!started) return enriched();
    add("playerName", playerName!, "Decoded player name.");
    const rivalName = decodeName(bytes(layout.rivalName, 11));
    if (rivalName) add("rivalName", rivalName, "Decoded rival name.");
    const width = byte(layout.mapWidth) * 2; const height = byte(layout.mapHeight) * 2;
    if (width && height) {
      add("mapId", byte(layout.mapId), "Internal map ID, not a map name. Location persists while menus or battles are open.");
      add("playerX", byte(layout.mapX), "Player map column in movement squares, zero based; persists in menus and battles.");
      add("playerY", byte(layout.mapY), "Player map row in movement squares, zero based; persists in menus and battles.");
      add("mapWidth", width, "Map width in movement squares (two squares per map block). Does not describe collision or exits.");
      add("mapHeight", height, "Map height in movement squares (two squares per map block).");
      add("facing", ({ 0: "down", 4: "up", 8: "left", 12: "right" } as Record<number, string>)[byte(layout.facing)] ?? "unknown", "Last overworld sprite facing direction; may be stale in menus and battles.");
    }
    add("movementMode", ["walking", "cycling", "surfing"][byte(layout.movementMode)] ?? "unknown", "Overworld movement mode.");
    const money = decodeBcd(bytes(layout.money, 3));
    add("money", money ?? "unknown", "Player money decoded from three packed-BCD bytes; malformed data remains unknown.");
    const badges = byte(layout.badges);
    add("badgeCount", countBits(Uint8Array.of(badges)), "Number of badge bits set; evidence of badges, not verified goal completion.");
    add("badges", badgeNames.filter((_name, bit) => badges & (1 << bit)).join(", ") || "none", "Names of the eight earned badges from the badge bit field.");
    add("pokedexOwned", countBits(bytes(layout.pokedexOwned, 19), 151), "Owned species count from the first 151 Pokédex bits; ignores unused padding.");
    add("pokedexSeen", countBits(bytes(layout.pokedexSeen, 19), 151), "Seen species count from the first 151 Pokédex bits.");
    const bagCount = byte(layout.bagCount);
    add("bagCount", bagCount <= 20 ? bagCount : "unknown", "Number of occupied bag slots, at most 20.");
    if (bagCount <= 20) add("bagItems", Array.from({ length: bagCount }, (_, slot) => {
      const entry = bytes(layout.bagItems + slot * 2, 2);
      return `id=${entry[0]},qty=${entry[1]}`;
    }).join("; ").slice(0, 256) || "empty", "Bag item IDs and quantities in slot order; IDs are not item names. Clipped to 256 characters.");
    const partyCount = byte(layout.partyCount);
    add("partyCount", partyCount <= 6 ? partyCount : "unknown", "Current party size, at most six. Unused slots are not interpreted.");
    const menuRows = `${screen.top}\n${screen.bottom}`.split("\n").map(menuLabel);
    if (!inBattle && phase === "menu" && ["POKEMON", "ITEM", "SAVE", "OPTION", "EXIT"].every((label) => menuRows.includes(label))) {
      add("menuKind", "overworld", "The START menu for party, items, saving, and options. Opening or closing it does not move the player or obtain a starter.");
      const selected = menuLabel(screen.cursor!.row);
      add("menuSelection", selected, "Highlighted START-menu entry. POKEMON cannot open the party screen when partyCount is zero.");
      if (selected === "POKEMON" && partyCount === 0) add("menuSelectionEffect", "The party is empty. Confirming POKEMON has no effect; select another entry or close the menu to explore.", "No party exists to show. This menu does not give the player a Pokemon.");
    }
    if (partyCount <= 6) for (let slot = 0; slot < partyCount; slot++) {
      const mon = bytes(layout.partyMons + slot * 44, 44);
      add(`party${slot + 1}`, this.describeMon(mon, bytes(layout.partyNicks + slot * 11, 11), false), "Nickname, internal species ID (not Pokédex number), level, HP, types, and status. Party HP can lag behind active battle HP.");
      add(`party${slot + 1}Moves`, this.describeMoves(mon, false), "Move slots 1-4 with internal move IDs and remaining PP (excludes PP Up bits); choose moves using the visible menu.");
    }
    add("battleKind", ({ 0: "none", 1: "wild", 2: "trainer", 255: "lost" } as Record<number, string>)[battle] ?? "unknown", "Battle flag; lost is a transient result, not an active enemy.");
    if (inBattle) {
      add("battleType", ["normal", "old_man_demo", "safari"][byte(layout.battleType)] ?? "unknown", "Battle variant. Safari and demonstration battles use different controls from ordinary fights.");
      add("battlePlayer", this.describeMon(bytes(layout.battleMon, 29), bytes(layout.battleNick, 11), true), "Active battle Pokémon, including current HP and status; may be unavailable during send-out transitions.");
      add("battlePlayerMoves", this.describeMoves(bytes(layout.battleMon, 29), true), "Active battle move slots and remaining PP; party PP can lag until the battle ends.");
      add("battleEnemy", this.describeMon(bytes(layout.enemyMon, 29), bytes(layout.enemyNick, 11), true), "Current enemy Pokémon and HP; omitted after battle. May be unavailable during send-out transitions.");
    }
    return enriched();
  }

  availableActions(state: GameState, actions: readonly AgentAction[]): readonly AgentAction[] {
    this.pulseFrames = Math.min(actions.find(action => action.id === "wait")?.frames ?? 8, 8);
    const emptyPartySelection = state.values.menuKind === "overworld" && state.values.menuSelection === "POKEMON" && state.values.partyCount === 0;
    return [...this.support.actions(state), ...(this.combat?.actions(state) ?? []), ...actions.filter((action) => action.stop || action.id === "wait" || state.values.phase !== "transition" && action.buttons.length === 1 &&
      !(emptyPartySelection && action.buttons[0] === "A") && this.support.allows(state, action.buttons[0]!) && (this.combat?.allows(state, action.buttons[0]!) ?? true))
      .map((action) => {
        if (action.stop || action.id === "wait") return action;
        const button = action.buttons[0]!;
        const menu = state.values.phase === "menu" || state.values.phase === "naming";
        const text = state.values.phase === "text";
        const descriptions: Record<string, string> = {
          A: menu ? "Confirm the highlighted menu choice or naming-grid character." : text ? "Advance or acknowledge text when the game accepts input." : "Interact or confirm; in battle, confirm the current choice.",
          B: state.values.phase === "naming" ? "Delete the last naming character." : "Cancel or go back where permitted; some prompts require A.",
          START: state.values.phase === "naming" ? "Finish naming once at least one character is entered." : state.values.menuKind === "overworld" ?
            "Close the START menu and return to exploration. Repeatedly opening and closing it does not advance exploration." : state.values.gameStarted ?
              "Open or close the overworld menu where permitted. This manages party, items, saving, and options; it does not move the player or obtain a starter." : "Leave the title screen or confirm supported menus.",
          SELECT: "Use SELECT only where the current menu supports it, such as naming or item ordering.",
        };
        const evidence = state.decisionSupport?.actionFacts[action.id] ?? [];
        const description = descriptions[button] ?? (menu || state.values.phase === "battle" ? `Move the menu cursor ${button.toLowerCase()} where supported.` : `Move or turn ${button.toLowerCase()} in the overworld; navigate choices during the intro.`);
        // Menu repeats can skip choices with long holds. Preserve user-configured shorter durations.
        const frames = Math.min(action.frames, 8);
        const detail = evidence.join(" ");
        const availabilityKey = [state.values.phase, state.values.mapId ?? "intro",
          ...(state.values.phase === "overworld" ? [state.values.playerX, state.values.playerY, state.values.facing] : []),
          ...(menu ? [state.values.menuKind ?? "unknown", state.values.menuCursorX, state.values.menuCursorY, state.values.enteredName ?? ""] : []),
          ...(state.values.phase === "battle" ? [this.combat?.contextKey(state) ?? "unknown", state.values.battleMenu ?? "other", state.values.battleMoveSelection ?? 0, state.values.menuCursorX, state.values.menuCursorY] : []),
          state.values.dialogueActive === true ? `dialogue${state.values.dialogueSession ?? ""}` : ""].join(":");
        return { ...action, frames, availabilityKey,
          description: `${description}${detail ? ` Facts: ${detail.slice(0, 270)}` : ""} Press ${button} for ${frames} frames, then release for 4 frames.` };
      })];
  }

  private describeMon(mon: Uint8Array, name: Uint8Array, battle: boolean): string {
    const level = mon[battle ? 14 : 33]!;
    const hp = mon[1]! * 256 + mon[2]!;
    const maxOffset = battle ? 15 : 34;
    const maxHp = mon[maxOffset]! * 256 + mon[maxOffset + 1]!;
    if (!mon[0] || mon[0]! > 190 || level < 1 || level > 100 || !maxHp || hp > maxHp) return "unavailable (uninitialized or transitional data)";
    const types = [...new Set([mon[5]!, mon[6]!])].map((id) => pokemonTypeNames[id] ?? `typeId=${id}`).join("/");
    return `${decodeName(name) ?? "unnamed"}; speciesId=${mon[0]}; level=${level}; HP=${hp}/${maxHp}; ${types}; ${status(mon[4]!, hp)}`;
  }

  private describeMoves(mon: Uint8Array, battle: boolean): string {
    if (mon[battle ? 14 : 33]! < 1 || mon[battle ? 14 : 33]! > 100 || !mon[0]) return "unavailable";
    const ppOffset = battle ? 25 : 29;
    return Array.from({ length: 4 }, (_, slot) => mon[8 + slot] ? `slot${slot + 1}: id=${mon[8 + slot]},PP=${mon[ppOffset + slot]! & 0x3f}` : "")
      .filter(Boolean).join("; ") || "none";
  }
}

import type { AgentAction, CompletedGameAction, GameState, Objectives, StateValue } from "../../core/agent.js";
import type { GameReaderMemory, GameStateData } from "../../core/game-reader.js";
import type { PokemonNavigationLayout } from "./navigation-layout.js";
import { PokemonInteractionMemory } from "./interaction-memory.js";
import { PokemonStoryProgress } from "./progress.js";
import { PokemonRegionGraph } from "./region-graph.js";
import { PokemonRouteFeedback, type PokemonRoute, type PokemonRouteOutcome } from "./navigation-execution.js";
import { pokemonLocation as location } from "./locations.js";
import { PokemonTravelMemory } from "./travel-memory.js";
import type { PokemonItemCatalog } from "./item-catalog.js";
import type { PokemonPreparationSupport } from "./preparation-support.js";
import { landEncounterTile } from "./encounter-tiles.js";
import { PokemonFocusMemory, type PokemonFocus } from "./focus.js";

const directions = [
  { name: "up", button: "UP", dx: 0, dy: -1, facing: 4, connection: 8 },
  { name: "down", button: "DOWN", dx: 0, dy: 1, facing: 0, connection: 4 },
  { name: "left", button: "LEFT", dx: -1, dy: 0, facing: 8, connection: 2 },
  { name: "right", button: "RIGHT", dx: 1, dy: 0, facing: 12, connection: 1 },
] as const;
type Direction = typeof directions[number];
interface Point { readonly x: number; readonly y: number }
interface Target extends Point {
  readonly id?: string;
  readonly label: string; readonly interact: boolean; readonly boulder?: boolean;
  readonly destination?: number; readonly triggers?: readonly Direction[]; readonly squares?: readonly Point[];
  readonly boundary?: Direction;
  readonly pickup?: string;
  readonly arrivalOnly?: boolean;
  readonly trainer?: string;
  readonly canCollect?: boolean;
  readonly stepOffWarp?: boolean;
}
const key = ({ x, y }: Point) => `${x},${y}`;
const actionId = (direction: Direction) => `press_${direction.name}`;

/** Original, profile-local mechanics. Provides facts and routes, never chooses a goal or action. */
export class GenerationOneDecisionSupport {
  // Cartridge caching is immutable; bounded dialogue history is separate from fresh navigation.
  private readonly banks = new Map<number, Uint8Array>();
  private readonly interactions = new PokemonInteractionMemory();
  private readonly story: PokemonStoryProgress;
  private readonly graph = new PokemonRegionGraph();
  private readonly routes = new Map<string, PokemonRoute>();
  private readonly attempts = new PokemonRouteFeedback();
  private readonly travel = new PokemonTravelMemory();
  private readonly focus = new PokemonFocusMemory();
  private planningActive = false;
  private focusOptions: readonly PokemonFocus[] = [];
  private progressSignature = "";
  private contextKey = "";
  private healingReview = 0;
  private importantFacts: string[] = [];
  private readonly layout: PokemonNavigationLayout | undefined;
  constructor(layout?: PokemonNavigationLayout, private readonly preparation?: PokemonPreparationSupport) {
    this.layout = layout ? { ...layout } : undefined;
    this.story = new PokemonStoryProgress(layout?.collisionBank === 1);
    if (layout) for (const [name, address] of Object.entries(layout)) {
      if (!Number.isSafeInteger(address) || (name === "collisionBank" ? address < 0 || address > 255 :
          name === "tilePairs" || name === "ledges" || name === "warpTiles" || name === "tilesets" ? address < 0 || address >= 8 * 1024 * 1024 : address < 0xc000 || address > 0xdfff)) {
        throw new Error("Invalid Generation I navigation layout.");
      }
    }
  }
  reset(): void {
    this.banks.clear(); this.interactions.reset(); this.story.reset(); this.graph.reset(); this.routes.clear(); this.attempts.reset(); this.travel.reset();
    this.contextKey = ""; this.progressSignature = ""; this.focus.reset(); this.preparation?.reset(); this.planningActive = false; this.focusOptions = [];
    this.healingReview = 0; this.importantFacts = [];
  }
  setObjectives(objectives: Objectives): void { this.story.setObjectives(objectives); this.attempts.reset(); this.travel.reset(); this.focus.reset(); }
  onActionComplete(event: CompletedGameAction): void { if (this.planningActive) this.focus.complete(event); }
  needsFocus(state: GameState): boolean { return this.planningActive && this.focus.needsChoice && state.values.phase === "overworld" && state.values.navigationStatus === "ready" && this.focusOptions.length > 0; }
  focusActions(state: GameState): readonly AgentAction[] {
    if (!this.planningActive || state.values.phase !== "overworld" || state.values.navigationStatus !== "ready") return [];
    if (this.focus.needsChoice) return this.focus.choices(state.values, this.focusOptions, focus => this.preparation?.note(focus) ?? "");
    const healing = this.preparation?.needsHealing && this.focus.current !== "heal" && this.focusOptions.includes("heal") ?
      this.focus.choices(state.values, ["heal"], focus => this.preparation!.note(focus)) : [];
    return [...healing, { id: "reconsider_focus", description: "Reconsider the current persistent purpose using a fresh Jev choice. Use when its evidence or usefulness is uncertain; no controller input or alternative destination is executed.",
      buttons: [], frames: 1, stop: false, execution: "profile", availabilityKey: `review:${this.focus.version}` }];
  }
  focusExecution(id: string) { return id === "reconsider_focus" ? this.focus.review() : this.focus.select(id); }
  focusKey(): string { return this.planningActive ? `focus:${this.focus.current ?? "choose"}:${this.focus.version}` : ""; }
  route(id: string): PokemonRoute | undefined { return this.routes.get(id); }
  nearbyPickups(): readonly string[] { return [...this.routes.values()].filter(route => route.nearbyPickup).map(route => route.id).slice(0, 15); }
  remember(target: PokemonRoute, outcome: PokemonRouteOutcome): void { this.attempts.remember(target, outcome); }
  priorityActions(state: GameState): readonly AgentAction[] { return this.actions(state).filter(action => {
    const route = this.routes.get(action.id); return route?.nearbyPickup || route?.stepOffWarp;
  }).slice(0, 8); }
  actions(state: GameState): readonly AgentAction[] {
    if (state.values.phase !== "overworld" || state.values.movementInProgress) return [];
    const pickupKey = this.nearbyPickups().reduce((mask, id) => mask | 1 << (Number(id.slice("interact_object_".length)) - 1), 0).toString(16);
    return [...this.routes.values()].map(route => ({ id: route.id, description: [
      `${route.label.startsWith("Item ball:") ? "Approach and pick up" : route.interact ? "Approach and interact with" : "Walk to"} ${route.label}. ${route.length} local step(s).`,
      route.navigationFact ?? (route.towardObjective ? "A known interaction relates to the active supplied milestone." : "Choose only if useful for the user's goal or constraints."),
      this.focus.attemptFact(Number(state.values.mapId), route.id) ?? "",
      ...(route.destination === undefined ? [] : this.travel.routeFacts(Number(state.values.mapId), route.destination)),
      this.attempts.attempts(route) ? `Already attempted ${this.attempts.attempts(route)} time(s) without a new shortest distance or map change. Repeating the same partial approach is not new progress.` : "",
      "Execute this destination for at most 600 frames; stop for dialogue, battle, changed maps, or a blocked route.",
    ].filter(Boolean).join(" ").slice(0, 500), buttons: [], frames: 600, stop: false, execution: "profile" as const,
      availabilityKey: `${route.context}:${route.id}:loot${pickupKey}` }));
  }

  read(memory: GameReaderMemory, ram: Uint8Array, state: Readonly<Record<string, StateValue>>, inventory: readonly number[] = [], items?: PokemonItemCatalog, captureAvailable = false): GameStateData {
    this.routes.clear();
    this.importantFacts = state.phase === "overworld" ? ["Priority: follow supplied objectives and constraints. After battles, heal members at 50% HP or less before continuing. Urgent healing comes first. Collect nearby verified item balls before routine travel. Attempt every eligible wild species absent from the current team, regardless of Pokedex ownership or new types; buy missing balls first. Jev must select each action."] : [];
    let decisionGoal: string | undefined;
    const facts: string[] = [];
    const actionFacts: Record<string, string[]> = {};
    const values: Record<string, StateValue> = {};
    const descriptions: Record<string, string> = {};
    const interaction = this.interactions.read(state, this.layout ? ram.subarray(this.layout.eventFlags - 0xc000, this.layout.eventFlags - 0xc000 + 320) : new Uint8Array());
    const flags = this.layout ? ram.subarray(this.layout.eventFlags - 0xc000, this.layout.eventFlags - 0xc000 + 320) : new Uint8Array();
    const settledState = { ...state, ...(this.layout ? {
      movementInProgress: ram[this.layout.walkCounter - 0xc000]! > 0,
      controlBusy: (ram[this.layout.joyIgnore - 0xc000]! & 0xf0) === 0xf0,
    } : {}) };
    const progress = this.story.read(flags, settledState, inventory);
    this.planningActive = Boolean(this.layout && state.gameStarted === true && Number(state.partyCount) > 0 && progress?.values.pokedexReceived === true);
    const preparation = this.preparation?.read(memory, ram, { ...settledState, ...progress?.values }, items, captureAvailable);
    if (preparation) { Object.assign(values, preparation.values); Object.assign(descriptions, preparation.descriptions); state = { ...state, ...preparation.values }; }
    if (this.planningActive) this.focus.observe({ ...settledState, ...preparation?.values, ...(this.preparation ? { preparationHealthKey: this.preparation.healthKey, partyRestored: this.preparation.restored ?? false } : {}) }, String(progress?.values.completedStoryChecks ?? "custom"));
    if (this.preparation && this.preparation.postBattleReview > this.healingReview) {
      this.healingReview = this.preparation.postBattleReview;
      if (this.planningActive && this.focus.current !== "heal") this.focus.requireReview("A battle ended with 50% HP or less, status or low attack PP. Prioritize a healing purpose before further travel; opening START is not healing.");
    }
    if (this.planningActive && ["text", "menu"].includes(String(state.phase))) {
      if (state.menuKind === "overworld") decisionGoal = `Close START with B or START to continue the selected ${this.focus.current ?? "gameplay"} task. This menu does not heal, buy balls or pick up nearby objects. Supplied constraints remain authoritative.`;
      else if (this.focus.current === "shop" || this.focus.current === "catch" && this.preparation?.needsBalls) decisionGoal = "Continue the selected supply task through this dialogue/menu. Obtain missing capture balls from the clerk when affordable and storable. Select item, quantity and total-price confirmation separately; inspect the current prompt instead of abandoning the purchase for routine story travel.";
      else if (this.focus.current === "heal") decisionGoal = "Continue the selected healing task while resolving the current dialogue/menu. This may be a trainer or another interruption; do not assume it is the nurse. A known Center nurse heals for free. Jev chooses each answer; verify restored HP, status and PP before resuming travel.";
    }
    if (progress) {
      Object.assign(values, progress.values);
      for (const name of Object.keys(progress.values)) descriptions[name] = name === "completedStoryChecks" ?
        "Recognized milestone checkpoints satisfied by named events, badges, inventory, or an explicit visited-location check. Does not verify every instruction or the full user goal." :
        "Profile story evidence and the first pending recognized user milestone; custom text is not automatically verified.";
      facts.push(...progress.facts);
      this.contextKey = `${state.mapId}:${progress.objective?.id ?? "custom"}`;
    }
    const signature = `${progress?.values.completedStoryChecks ?? ""}:${state.badges}:${inventory.join(",")}:${state.bagItems ?? ""}:${state.partyCount}`;
    if (signature !== this.progressSignature) { this.progressSignature = signature; this.attempts.reset(); }
    const currentMap = typeof state.mapId === "number" ? state.mapId : undefined;
    this.travel.observe(currentMap, state.gameStarted === true && state.phase === "overworld" && !settledState.movementInProgress && !settledState.controlBusy, signature);
    if (currentMap !== undefined) facts.push(...this.travel.facts(currentMap));
    const finish = (): GameStateData => {
      const support = interaction.decisionSupport!;
      for (const [id, evidence] of Object.entries(preparation?.decisionSupport?.actionFacts ?? {})) actionFacts[id] = [...evidence, ...(actionFacts[id] ?? [])].slice(0, 8);
      for (const [id, evidence] of Object.entries(support.actionFacts)) actionFacts[id] = [...evidence, ...(actionFacts[id] ?? [])].slice(0, 8);
      return { values: { ...values, ...interaction.values }, descriptions: { ...descriptions, ...interaction.descriptions },
        decisionSupport: { facts: [...this.importantFacts.slice(0, 8), ...(preparation?.decisionSupport?.facts ?? []), ...(this.planningActive ? this.focus.facts() : []), ...support.facts, ...facts].slice(0, 32), actionFacts, ...(decisionGoal ? { decisionGoal } : {}) } };
    };
    const add = (name: string, value: StateValue, description: string) => { values[name] = value; descriptions[name] = description; };
    if (this.planningActive && state.phase === "overworld") {
      add("currentFocus", this.focus.current ?? "choose", "Persistent purpose selected by Jev. Map changes and incidental battles do not choose a new purpose.");
      add("focusStatus", this.focus.needsChoice ? "choose" : "active", "A fresh purpose choice is required after changed evidence, six actions without a new best route distance, or 32 actions. Reads alone never consume this review interval.");
    }
    if (state.phase === "transition") facts.push("Input is blocked or the display is changing. Wait for a stable screen before selecting another gameplay input.");
    if (state.phase === "text") facts.push("A text box is visible. A advances dialogue; walking controls do not move through the box. Text can still be printing.");
    if (state.phase === "naming") facts.push("This is a naming grid. A enters the highlighted character, B deletes, SELECT changes case, START finishes a nonempty entry. Follow the user's naming constraints.");
    if (state.menuKind === "overworld") {
      facts.push("The START menu manages party, items, saving, and options. Close it with B or START to explore. It cannot provide a starter or move the player.");
      actionFacts.press_a = [state.menuSelectionEffect ? String(state.menuSelectionEffect) : `Confirm the highlighted entry: ${state.menuSelection}.`];
    }
    if (typeof state.mapId === "number") add("locationName", location(state.mapId), "Verified Gen I map identifier; unknown maps retain their numeric ID. Not a progression objective.");
    if (state.partyCount === 0) facts.push("The party is empty. The POKEMON menu has nothing to show. Interacting with people or visible objects can open dialogue; opening START does not obtain a Pokemon.");
    if (state.phase !== "overworld" || !this.layout) return finish();

    const layout = this.layout;
    const u8 = (address: number) => ram[address - 0xc000]!;
    const u16 = (address: number) => u8(address) | u8(address + 1) << 8;
    if ((u8(layout.joyIgnore) & 0xf0) === 0xf0) {
      add("controlBusy", true, "All directional inputs are ignored by the current overworld script. A text box can still require dialogue choices.");
      facts.push("An overworld script controls the player; wait for control to return before selecting another walking target.");
      return finish();
    }
    if (u8(layout.walkCounter) > 0) {
      add("movementInProgress", true, "The live walking counter is nonzero; coordinates and collision evidence may still be changing.");
      facts.push("A movement animation is still running. Wait for it to finish; do not treat its current coordinates as a failed step.");
      return finish();
    }
    const width = Number(state.mapWidth); const height = Number(state.mapHeight);
    const player = { x: Number(state.playerX), y: Number(state.playerY) };
    const valid = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width % 2 === 0 && height % 2 === 0 &&
      (width / 2 + 6) * (height / 2 + 6) <= 1300 && player.x >= 0 && player.y >= 0 && player.x < width && player.y < height;
    if (!memory.readRom || !valid) {
      facts.push("Collision and route data are unavailable. Controller directions remain attempts; no claim of legal movement is made.");
      return finish();
    }
    if (state.movementMode !== "walking" && state.movementMode !== "cycling") {
      add("navigationStatus", "partial", "Walking collision rules do not verify the current movement mode.");
      facts.push("The current movement mode needs different collision rules. Directions remain available attempts; walking routes are not asserted.");
      return finish();
    }

    const romByte = (offset: number) => {
      const bank = Math.floor(offset / 0x4000);
      if (!this.banks.has(bank)) {
        if (this.banks.size === 4) this.banks.delete(this.banks.keys().next().value!);
        this.banks.set(bank, memory.readRom!(bank * 0x4000, 0x4000));
      }
      return this.banks.get(bank)![offset % 0x4000]!;
    };
    const flat = (pointer: number, bank = u8(layout.bank)) => pointer < 0x4000 ? pointer : bank * 0x4000 + pointer - 0x4000;
    const blockPointer = u16(layout.blocks); const collisionPointer = u16(layout.collision);
    // Corrupt or partially loaded pointers must not turn unknown terrain into blocked directions.
    if (blockPointer < 0x4000 || blockPointer >= 0x8000 || collisionPointer <= 0 || collisionPointer >= 0x8000) {
      facts.push("Tileset pointers are not initialized. Navigation remains unknown until the map is loaded.");
      return finish();
    }
    const passable = new Set<number>();
    let terminated = false;
    for (let index = 0; index < 256; index++) {
      const tile = romByte(flat(collisionPointer, layout.collisionBank) + index);
      if (tile === 0xff) { terminated = true; break; }
      passable.add(tile);
    }
    if (!terminated || passable.size === 0) {
      facts.push("The collision table is unavailable. Navigation remains unknown.");
      return finish();
    }
    const tileset = u8(layout.tileset);
    const tile = (x: number, y: number, right = false): number => {
      // The six-block padding includes the border and connected-map strips.
      const bx = Math.floor(x / 2) + 3; const by = Math.floor(y / 2) + 3;
      if (bx < 0 || by < 0 || bx >= width / 2 + 6 || by >= height / 2 + 6) return -1;
      const block = u8(0xc6e8 + by * (width / 2 + 6) + bx);
      const quadrant = ((y & 1) * 2 + 1) * 4 + (x & 1) * 2;
      return romByte(flat(blockPointer) + block * 16 + quadrant + Number(right));
    };
    const inside = (point: Point) => point.x >= 0 && point.y >= 0 && point.x < width && point.y < height;
    const pairs: number[][] = [];
    for (let index = 0; index < 96; index += 3) {
      const entry = [0, 1, 2].map(offset => romByte(layout.tilePairs + index + offset));
      if (entry[0] === 0xff) break;
      if (entry[0] === tileset) pairs.push(entry.slice(1));
    }
    const ledges: number[][] = [];
    if (tileset === 0) for (let index = 0; index < 64; index += 4) {
      const entry = [0, 1, 2, 3].map(offset => romByte(layout.ledges + index + offset));
      if (entry[0] === 0xff) break;
      ledges.push(entry);
    }
    const counters = new Set([u8(layout.counters), u8(layout.counters + 1), u8(layout.counters + 2)].filter(id => id !== 0xff));
    const hidden = new Set<number>();
    for (let index = 0; index < 32; index += 2) {
      const sprite = u8(layout.hiddenList + index);
      if (sprite === 0xff) break;
      const flag = u8(layout.hiddenList + index + 1);
      if (u8(layout.hiddenFlags + (flag >> 3)) & 1 << (flag & 7)) hidden.add(sprite);
    }
    const objects: Target[] = [];
    for (let index = 1; index <= Math.min(u8(layout.spriteCount), 15); index++) {
      if (hidden.has(index) || u8(0xc100 + index * 16) === 0) continue;
      const point = { x: u8(0xc200 + index * 16 + 5) - 4, y: u8(0xc200 + index * 16 + 4) - 4 };
      const picture = u8(0xc100 + index * 16), boulder = picture === 0x3f;
      const names: Readonly<Record<number, string>> = { 2: "Rival", 3: "Professor Oak", 38: "Shop clerk", 41: "Nurse", 51: "Mother", 61: "Poke Ball", 63: "Boulder", 65: "Pokedex" };
      const metadata = this.graph.object(Number(state.mapId), index, romByte, layout, memory.romByteLength ?? 0);
      const item = metadata?.picture === picture ? metadata.item : undefined;
      const pickup = item && item < 255 ? `${items?.name(item) ?? `itemId=${item}`}. ${state.bagCount === 20 && !inventory.includes(item) ? "No free bag slot for this item type; make space before collecting." : "A attempts collection; only a subsequent inventory/object change confirms the result."}` : undefined;
      const capacity = pickup ? this.preparation?.canCollect(ram, item!) : undefined;
      const trainer = metadata?.picture === picture ? metadata.trainer : undefined;
      if (inside(point)) objects.push({ ...point, id: `interact_object_${index}`, label: pickup ? `Item ball: ${items?.name(item!) ?? `itemId=${item}`} (object ${index})` : trainer ? `Trainer ${trainer} (object ${index})` : `${names[picture] ?? "Object"} ${index}`,
        interact: true, boulder, ...(pickup ? { pickup, ...(capacity === undefined ? {} : { canCollect: capacity }) } : {}), ...(trainer ? { trainer } : {}) });
    }
    const occupied = new Set(objects.map(key));
    const warps: Target[] = [];
    const automaticWarpTiles = new Set<number>();
    let warpTilesReady = false;
    if (tileset < 24) {
      const pointer = romByte(layout.warpTiles + tileset * 2) | romByte(layout.warpTiles + tileset * 2 + 1) << 8;
      if (pointer >= 0x4000 && pointer < 0x8000) for (let index = 0; index < 32; index++) {
        const value = romByte(flat(pointer, Math.floor(layout.warpTiles / 0x4000)) + index);
        if (value === 0xff) { warpTilesReady = true; break; }
        automaticWarpTiles.add(value);
      }
    }
    // ExtraWarpCheck uses facing-edge rules for ordinary indoor tilesets, with engine exceptions.
    const edgeWarp = state.mapId === 0x61 || ![0x52, 0xc7, 0xc8, 0xca].includes(Number(state.mapId)) && ![0, 13, 14, 23].includes(tileset);
    const triggersAt = (point: Point) => edgeWarp && warpTilesReady && !automaticWarpTiles.has(tile(point.x, point.y)) ?
      directions.filter(direction => !inside({ x: point.x + direction.dx, y: point.y + direction.dy })) : [];
    for (let index = 0; index < Math.min(u8(layout.warpCount), 32); index++) {
      const address = layout.warps + index * 4;
      const point = { x: u8(address + 1), y: u8(address) };
      const raw = u8(address + 3); const destination = raw === 0xff ? u8(layout.lastMap) : raw;
      if (inside(point)) warps.push({ ...point, id: `go_exit_${index + 1}`, label: `Exit ${index + 1} to ${location(destination)}`, interact: false, destination, triggers: triggersAt(point) });
    }
    const warpKeys = new Set(warps.map(key));
    // Adjacent entries to one destination represent one doorway, not competing destinations.
    const warpTargets: Target[] = [];
    const ungrouped = new Set(warps);
    for (const warp of warps) {
      if (!ungrouped.delete(warp)) continue;
      const group = [warp];
      for (let index = 0; index < group.length; index++) for (const other of ungrouped) {
        if (other.destination === warp.destination && Math.abs(other.x - group[index]!.x) + Math.abs(other.y - group[index]!.y) === 1) {
          ungrouped.delete(other); group.push(other);
        }
      }
      warpTargets.push({ ...warp, squares: group, triggers: directions.filter(direction => group.some(entry => entry.triggers?.includes(direction))) });
    }
    const standingWarp = warps.find(warp => key(warp) === key(player));
    const standingAutomaticWarp = Boolean(standingWarp && warpTilesReady && automaticWarpTiles.has(tile(player.x, player.y)));
    const standingGroup = warpTargets.find(warp => warp.squares?.some(point => key(point) === key(player)));
    if (standingWarp) {
      add("standingExit", standingWarp.label, "Live warp entry under the player. Reaching its coordinates alone does not prove a map transition.");
      if (standingWarp.triggers!.length) {
        add("exitTriggerInputs", standingWarp.triggers!.map(actionId).join(", "), "Facing-edge warp directions toward the outside; scripts can still delay or block the transition.");
        facts.push(`On an exit to ${location(standingWarp.destination!)}. Activate it with ${standingWarp.triggers!.map(actionId).join(" or ")}, facing toward the outside. A short press may only turn first; another press in that same direction can activate it. Moving sideways between adjacent mats to the same destination does not leave the map. Wait if a transition begins.`);
      }
    }
    const connectionMask = u8(layout.connections);
    const step = (from: Point, direction: Direction): { point: Point; reason: string; allowed: boolean } => {
      let point = { x: from.x + direction.dx, y: from.y + direction.dy };
      const current = tile(from.x, from.y); const next = tile(point.x, point.y);
      if (objects.some(object => object.boulder && key(object) === key(point)) && (u8(layout.strengthFlags) & 1)) {
        return { point, reason: "unknown Strength push; the boulder and landing-square rules must be checked by the game", allowed: false };
      }
      if (occupied.has(key(point))) return { point, reason: "occupied by an active map object; face it and use A to interact", allowed: false };
      if (!inside(point) && !(connectionMask & direction.connection)) return { point, reason: "map boundary with no connection", allowed: false };
      const ledge = ledges.some(entry => entry[0] === direction.facing && entry[1] === current && entry[2] === next);
      if (ledge) {
        point = { x: point.x + direction.dx, y: point.y + direction.dy };
        const allowed = inside(point) && passable.has(tile(point.x, point.y)) && !occupied.has(key(point));
        return { point, reason: allowed ? "one-way ledge jump" : "ledge landing blocked or outside the map", allowed };
      }
      if (pairs.some(([a, b]) => current === a && next === b || current === b && next === a)) return { point, reason: "tile-pair collision", allowed: false };
      const allowed = passable.has(next);
      return { point, allowed, reason: !allowed ? "solid terrain" :
        warpKeys.has(key(point)) ? "exit/warp square; its trigger can require another directional input" :
        !inside(point) ? "connected map boundary" : next === u8(layout.grass) ? "walkable grass; wild encounters may occur" : "walkable terrain" };
    };
    add("navigationStatus", "ready", "Current live map blocks, ROM collision rules, objects, and exits. Scripts and special field mechanics can still reject a step.");
    for (const direction of directions) {
      const result = step(player, direction);
      const blocked = !result.allowed && !result.reason.startsWith("unknown ");
      const turning = blocked && state.facing !== direction.name;
      add(`step${direction.button}`, blocked ? turning ? "turn_only" : "blocked" : result.allowed ? "walkable" : "unknown", "Local movement availability from decoded terrain and objects; a turn-only input cannot walk into the obstacle.");
      actionFacts[actionId(direction)] = [`${direction.button}: ${result.reason} at (${result.point.x},${result.point.y}).${turning ? " This input can only turn; it will not move the player." : ""}`];
      // A warp underfoot can activate on a collision; do not hide its trigger directions.
      if (blocked && warpKeys.has(key(player))) {
        values[`step${direction.button}`] = "unknown";
        actionFacts[actionId(direction)]!.push("Standing on an exit/warp. A directional attempt may trigger it even if the neighboring tile is solid.");
      }
      if (standingWarp?.triggers?.includes(direction)) {
        values[`step${direction.button}`] = "exit_trigger";
        actionFacts[actionId(direction)] = [`${direction.button}: activate the exit to ${location(standingWarp.destination!)} by pressing toward the outside. ${state.facing === direction.name ? "Already facing that edge; this is an exit trigger, not an ordinary blocked step." : "A short input may only turn first. After turning, press this same direction again to activate the exit."} Scripts can still delay or block it.`];
      } else if (standingWarp?.triggers?.length && standingGroup?.squares?.some(point => key(point) === key(result.point))) {
        actionFacts[actionId(direction)]!.unshift(`${direction.button} moves between squares of the SAME exit to ${location(standingWarp.destination!)}; it does not activate the edge exit. Exit trigger inputs: ${standingWarp.triggers.map(actionId).join(", ")}.`);
      }
    }
    const facing = directions.find(direction => direction.name === state.facing);
    const front = facing ? { x: player.x + facing.dx, y: player.y + facing.dy } : undefined;
    const signs: Target[] = [];
    for (let index = 0; index < Math.min(u8(layout.signCount), 16); index++) {
      const point = { x: u8(layout.signs + index * 2 + 1), y: u8(layout.signs + index * 2) };
      if (inside(point)) signs.push({ ...point, id: `interact_sign_${index + 1}`, label: `Sign ${index + 1}`, interact: true });
    }
    const interactable = [...objects, ...signs];
    const ahead = front ? interactable.find(target => key(target) === key(front) || facing && counters.has(tile(front.x, front.y)) &&
      target.x === front.x + facing.dx && target.y === front.y + facing.dy) : undefined;
    actionFacts.press_a = [ahead ? `Facing ${ahead.label} at (${ahead.x},${ahead.y}). A interacts with it.${ahead.pickup ? ` ${ahead.pickup}` : ""}` : "No decoded object or sign is in front. A may examine background scenery; it does not walk or open START."];
    facts.push("Routes are local distances from the current map, not a walkthrough or verified goal progress. Jev chooses which exit or interaction is useful. Objects may move and scripts can block apparent routes.");
    facts.push("Walking finishes over several frames. A released short press can still be moving at action completion; wait when movementInProgress is true.");

    // Breadth-first distances expose all equally short first directions, without selecting a target.
    const size = width * height;
    const distance = new Int32Array(size).fill(-1); const first = new Uint8Array(size);
    const indexOf = (point: Point) => point.y * width + point.x;
    const queue: Point[] = [player]; distance[indexOf(player)] = 0;
    for (let head = 0; head < queue.length && head < size * 5; head++) {
      const current = queue[head]!; const index = indexOf(current);
      if (key(current) !== key(player) && warpKeys.has(key(current))) continue;
      for (let dirIndex = 0; dirIndex < directions.length; dirIndex++) {
        const result = step(current, directions[dirIndex]!);
        if (!result.allowed || !inside(result.point)) continue;
        const next = indexOf(result.point); const length = distance[index]! + 1;
        const mask = index === indexOf(player) ? 1 << dirIndex : first[index]!;
        if (distance[next] === -1) { distance[next] = length; first[next] = mask; queue.push(result.point); }
        else if (distance[next] === length && (first[next]! | mask) !== first[next]) { first[next] = first[next]! | mask; queue.push(result.point); }
      }
    }
    const goalsFor = (target: Target): Point[] => {
      if (!target.interact) return target.squares ? [...target.squares] : [target];
      return directions.flatMap(direction => {
        const point = { x: target.x - direction.dx, y: target.y - direction.dy };
        const goals = [point];
        if (counters.has(tile(point.x, point.y))) goals.push({ x: point.x - direction.dx, y: point.y - direction.dy });
        return goals;
      }).filter(inside);
    };
    const targets = [...warpTargets, ...objects, ...signs.slice(0, 4)];
    if (standingAutomaticWarp) {
      const away = directions.flatMap(direction => {
        const result = step(player, direction);
        return result.allowed && inside(result.point) && !warpKeys.has(key(result.point)) ? [{ ...result.point, id: `step_off_exit_${direction.name}`,
          label: `Step off the current automatic stair ${direction.name}; then select ${standingWarp!.id} again to re-enter that same exit`,
          interact: false, arrivalOnly: true, stepOffWarp: true }] : [];
      });
      targets.push(...away);
      this.importantFacts.push(`Priority: already standing on ${standingWarp!.label}, an automatic stair landing. Waiting, START or choosing the same zero-distance exit does not re-enter it. To return through this stair, Jev must first choose one available step_off_exit action, then choose ${standingWarp!.id} from the next position. No step or return is chosen automatically.`);
    }
    const grassTargets: Target[] = [];
    const landEncounters = this.preparation?.catalog.landEncounters(Number(state.mapId));
    for (let y = 0; y < height && grassTargets.length < 4; y++) for (let x = 0; x < width && grassTargets.length < 4; x++) {
      if ((x !== player.x || y !== player.y) && (landEncounters !== undefined ? landEncounters.length > 0 &&
        landEncounterTile(Number(state.mapId), tileset, u8(layout.grass), tile(x, y), tile(x, y, true), layout.collisionBank === 1) :
        u8(layout.grass) !== 255 && tile(x, y) === u8(layout.grass)) && distance[y * width + x]! > 0 && !warpKeys.has(`${x},${y}`)) {
        grassTargets.push({ x, y, id: `walk_grass_${x}_${y}`, label: `${tile(x, y) === u8(layout.grass) ? "Tall grass" : "Land encounter square"} at (${x},${y})`, interact: false, arrivalOnly: true });
      }
    }
    if (this.focus.current === "train" || this.focus.current === "catch") targets.push(...grassTargets);
    for (const direction of directions) if (connectionMask & direction.connection) {
      const candidates: Point[] = [];
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const point = { x, y }; const result = step(point, direction);
        if (distance[indexOf(point)]! >= 0 && result.allowed && !inside(result.point)) candidates.push(point);
      }
      candidates.sort((a, b) => distance[indexOf(a)]! - distance[indexOf(b)]!);
      const exit = candidates[0];
      if (exit) targets.push({ ...exit, id: `go_boundary_${direction.name}`, destination: u8(layout.connections + 1 + directions.indexOf(direction) * 11), boundary: direction,
        label: `${direction.name} boundary to ${location(u8(layout.connections + 1 + directions.indexOf(direction) * 11))}`, interact: false });
    }
    const earlyGame = [0, 1, 2, 12, 13, 33, 37, 38, 39, 40, 41, 42, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58].includes(Number(state.mapId));
    const supplies = !this.planningActive && earlyGame && state.pokeBalls === 0 && Number(state.partyCount) > 0 ? this.graph.guidanceToAny(Number(state.mapId), player, [42, 56], romByte, layout, memory.romByteLength ?? 0) : undefined;
    if (supplies?.here !== undefined) facts.push(`Capture supplies are empty. Viridian/Pewter Mart is ${supplies.here} static walking-area transition(s) away; supplies require money, bag space and completed shop prerequisites. Supply detours are optional Jev choices, separate from the story milestone.`);
    const regional = progress?.objective && (!this.planningActive || !this.focus.current || this.focus.current === "progress" || this.focus.current === "explore") ? this.graph.guidance(Number(state.mapId), player, progress.objective.map,
      romByte, layout, memory.romByteLength ?? 0) : undefined;
    const captureSupplies = this.focus.current === "catch" && this.preparation?.needsBalls === true;
    const shopping = this.planningActive && (!this.focus.current || this.focus.current === "shop" || captureSupplies) ? this.graph.serviceGuidance("shop", Number(state.mapId), player, romByte, layout, memory.romByteLength ?? 0) : undefined;
    const healing = this.planningActive && (!this.focus.current || this.focus.current === "heal" || this.preparation?.needsHealing) ? this.graph.serviceGuidance("heal", Number(state.mapId), player, romByte, layout, memory.romByteLength ?? 0) : undefined;
    const encounterMaps = this.preparation?.encounterMaps(this.focus.current !== "train") ?? [];
    const encounters = this.planningActive && (!this.focus.current || this.focus.current === "train" || this.focus.current === "catch" && !captureSupplies) && encounterMaps.length ?
      this.graph.encounterGuidance(Number(state.mapId), player, encounterMaps, romByte, layout, memory.romByteLength ?? 0) : undefined;
    const knownEncounters = grassTargets.length > 0 || encounters?.here !== undefined;
    if (this.focus.needsChoice) this.focusOptions = ["progress", "explore", ...(shopping?.here !== undefined && Number(state.money) > 0 &&
      (Number(state.bagCount) < 20 || this.preparation?.needsMedicineSupplies || this.preparation?.canBuyBalls) ? ["shop" as const] : []),
      ...(healing?.here !== undefined && this.preparation?.restored !== true ? ["heal" as const] : []), ...(knownEncounters ? ["train" as const] : []),
      ...(knownEncounters && (this.preparation ? this.preparation.canStoreCapture && (Number(state.pokeBalls) > 0 || shopping?.here !== undefined && this.preparation.canBuyBalls) : Number(state.pokeBalls) > 0) ? ["catch" as const] : [])];
    else this.focusOptions = healing?.here !== undefined && this.preparation?.restored !== true ? ["heal"] : [];
    this.focusOptions = [...this.focusOptions].sort((a, b) => {
      const rank = (focus: PokemonFocus) => this.preparation?.needsHealing && focus === "heal" ? 0 :
        this.preparation?.needsMedicineSupplies && focus === "shop" ? 1 : focus === "catch" ? 1 : focus === "shop" ? 2 : 3;
      return rank(a) - rank(b);
    });
    const focusGuidance = this.focus.current === "shop" || captureSupplies ? shopping : this.focus.current === "heal" ? healing : this.focus.current === "progress" ? regional :
      this.focus.current === "train" || this.focus.current === "catch" ? encounters : undefined;
    if (captureSupplies) facts.unshift("Jev's capture purpose currently needs balls. Reach a Mart, interact with the clerk, choose a ball and confirm an affordable quantity/price separately. Buying supplies preserves this capture purpose; it does not capture a Pokemon.");
    else if (this.focus.current === "train" || this.focus.current === "catch") facts.unshift(`${this.preparation?.destinationFact(encounters?.candidateMaps ?? []) ?? "Seek reachable encounter tiles."} ${encounters?.here === undefined ? "A regional route is unknown; local controller attempts remain available." : `Encounter walking areas are ${encounters.here} static area transition(s) away.`} Arrival alone does not train or capture; continue choosing useful encounter squares and battle actions.`.slice(0, 500));
    if (progress?.objective) facts.push(`Navigation uses separate walking areas and exact warp landing coordinates, not just map IDs. ${regional?.here === undefined ? "The static regional route to the active milestone is unknown." : `The current walking area is ${regional.here} static area transition(s) from the milestone's map.`} Trees, water, scripts, moving objects and other special mechanics can change access; this is not verified story progress.`);
    this.contextKey = `${state.mapId}:${progress?.objective?.id ?? "custom"}:${progress?.objective?.map ?? "unknown"}${this.planningActive ? `:${this.focus.current ?? "choose"}:${this.focus.version}` : ""}`;
    const candidateRoutes: (PokemonRoute & { readonly focusMatch: boolean })[] = [];
    const routeFacts = targets.map(target => {
      const goals = goalsFor(target).filter(point => distance[indexOf(point)]! >= 0);
      const length = goals.length ? Math.min(...goals.map(point => distance[indexOf(point)]!)) : null;
      const nearbyPickup = Boolean(target.pickup && target.canCollect && length !== null && length <= 8);
      const best = length === null ? [] : goals.filter(point => distance[indexOf(point)] === length);
      const mask = best.reduce((bits, point) => bits | first[indexOf(point)]!, 0);
      const next = length === 0 ? target.boundary ? [target.boundary] : target.squares && standingWarp ? [...standingWarp.triggers!] : [] : directions.filter((_direction, index) => mask & 1 << index);
      let towardObjective = false;
      let navigationFact: string | undefined = target.pickup;
      const landingDistances = (guidance: typeof regional) => target.destination === undefined ? [] : target.boundary ? [guidance?.exitDistance({ ...target, destination: target.destination,
        direction: directions.indexOf(target.boundary) })] : warps.filter(warp =>
        (target.squares ?? [target]).some(point => key(point) === key(warp))).map(warp =>
        guidance?.exitDistance({ ...warp, destination: target.destination!, warp: Number(warp.id!.slice(8)) - 1 }));
      const consistent = (distances: readonly (number | undefined)[]) => distances.length && distances.every(value => value !== undefined && value === distances[0]) ? distances[0] : undefined;
      if (progress?.objective) {
        const objective = progress.objective;
        if (target.destination !== undefined) {
          const here = regional?.here;
          // A grouped doorway can be reached on either square; differing landing areas remain unknown.
          const there = consistent(landingDistances(regional));
          towardObjective = length !== null && there !== undefined && (target.destination === objective.map || here !== undefined && there < here);
          navigationFact = there === undefined ? "Regional route to the active supplied milestone is unknown; shared map IDs alone do not establish onward travel." :
            `${towardObjective ? "Leads toward" : here !== undefined && there > here ? "Leads away from" : "Does not establish a closer route to"} the active supplied milestone (${there} static walking-area transition(s) from its map). Scripts and special mechanics may change access.`;
          if (objective.id === "meet_oak" && state.mapId === 0 && target.destination === 12) {
            towardObjective = length !== null;
            navigationFact = "Leads toward the active supplied milestone: approaching Pallet Town's north exit triggers Oak's encounter.";
          }
          if (objective.id === "first_rival" && state.mapId === 40 && target.destination === 0) {
            towardObjective = length !== null;
            navigationFact = "Leads toward the active supplied milestone: trying to leave Oak's laboratory after receiving a starter triggers the rival battle.";
          }
        } else if (state.mapId === objective.map && target.interact) {
          const plain = (text: string) => text.toUpperCase().replace(/[^A-Z]/g, "");
          towardObjective = objective.id === "starter" ? layout.collisionBank === 1 ? target.label.startsWith("Professor Oak") : target.label.startsWith("Poke Ball") :
            Boolean(target.trainer && plain(objective.goal).includes(plain(target.trainer))) || target.label.startsWith("Professor Oak") || target.label.startsWith("Shop clerk");
          if (towardObjective) navigationFact = "This interaction relates to the active supplied milestone at its destination. Arriving at the map or standing on an exit does not finish the task. Jev chooses whether to interact and prepare for any resulting battle.";
        }
      }
      const supplyDistance = consistent(landingDistances(supplies));
      if (length !== null && supplies?.here !== undefined && supplyDistance !== undefined && supplyDistance < supplies.here) {
        navigationFact = `${navigationFact ?? ""} Leads closer to a Viridian/Pewter Mart for missing capture supplies (${supplyDistance} static area transition(s)). This does not select a detour or establish shop availability.`.trim().slice(0, 500);
      }
      let focusMatch = false;
      if (this.planningActive && this.focus.current) {
        const focus = this.focus.current;
        const there = consistent(landingDistances(focusGuidance));
        focusMatch = focus === "progress" ? towardObjective : focus === "shop" ? target.label.startsWith("Shop clerk") || there !== undefined && shopping?.here !== undefined && there < shopping.here :
          focus === "heal" ? target.label.startsWith("Nurse") || there !== undefined && healing?.here !== undefined && there < healing.here :
            focus === "catch" && captureSupplies ? target.label.startsWith("Shop clerk") || there !== undefined && shopping?.here !== undefined && there < shopping.here :
            focus === "train" || focus === "catch" ? target.arrivalOnly === true || there !== undefined && encounters?.here !== undefined && there < encounters.here : !this.focus.attemptFact(Number(state.mapId), target.id ?? "");
        if (target.stepOffWarp) {
          const returnDistance = standingWarp?.destination === undefined ? undefined : focusGuidance?.exitDistance({
            x: standingWarp.x, y: standingWarp.y, destination: standingWarp.destination, warp: Number(standingWarp.id!.slice(8)) - 1,
          });
          focusMatch = returnDistance !== undefined && focusGuidance?.here !== undefined && returnDistance < focusGuidance.here;
        }
        navigationFact = `${focusMatch ? "Matches" : "Does not establish progress for"} Jev's persistent ${focus} focus. ${target.destination !== undefined && focusGuidance?.here === 0 ? "Leaves the focus destination; arrival alone does not perform its task. " : ""}${navigationFact ?? ""}`.slice(0, 500);
      }
      if (nearbyPickup) {
        navigationFact = `Priority: collect this nearby verified item (${length} walking step(s)) before routine onward travel; ${this.preparation?.needsHealing ? "healing has priority while HP/status/PP are unsafe. " : ""}This opportunity applies independently of the selected story purpose. ${target.pickup}`.slice(0, 500);
        this.importantFacts.push(`Priority: nearby collectible ${target.label}, ${length} step(s). ${this.preparation?.needsHealing ? "Heal first; otherwise choose" : "Choose"} ${target.id} to attempt pickup before routine travel; only observed inventory/object changes confirm it.`);
      } else if (target.stepOffWarp) navigationFact = `${focusMatch ? `Priority: Matches Jev's persistent ${this.focus.current} focus when returning through this stair.` : `Return option: re-entering this stair to ${location(standingWarp!.destination!)} does not establish a closer route to the selected purpose; compare other exits before returning.`} Walk off this landing only; Jev must then select ${standingWarp!.id} again if a return is desired. START and waiting cannot reactivate the stair.`;
      else if (target.pickup) navigationFact = `${target.canCollect === false ? "No known bag capacity for this pickup; make space first." : target.canCollect === undefined ? "Verified loot opportunity; bag capacity is unknown." : "Verified loot opportunity; collect when nearby before routine travel."} ${target.pickup}`.slice(0, 500);
      // A known automatic landing requires leaving and re-entering, each explicitly chosen by Jev.
      const inactiveLanding = standingAutomaticWarp && length === 0 && target.destination !== undefined && !next.length;
      if (length !== null && target.id && !inactiveLanding) {
        candidateRoutes.push({ id: target.id, context: this.contextKey, label: target.label, length, nextButtons: next.map(direction => direction.button),
          interact: target.interact, x: target.x, y: target.y, towardObjective, focusMatch,
          ...(navigationFact ? { navigationFact } : {}),
          ...(target.arrivalOnly ? { arrivalOnly: true } : {}),
          ...(nearbyPickup ? { nearbyPickup: true } : {}), ...(target.stepOffWarp ? { stepOffWarp: true } : {}),
          ...(target.destination !== undefined ? { destination: target.destination } : {}) });
      }
      const at = (target.squares ?? [target]).map(point => `(${point.x},${point.y})`).join("/").slice(0, 96);
      const fact = target.arrivalOnly ? `${target.label} at ${at}: ${length ?? "unknown"} local step(s) to an encounter square. Walking there is an attempt, not a guaranteed encounter or capture.` : length === null ? `${target.label} at ${at}: no route found with current walking rules and objects; special mechanics may be needed.` :
        `${target.label} at ${at}: ${length} local step(s) ${target.interact ? "to an interaction position" : "to the exit"}. ${length ? `Shortest first inputs: ${next.map(actionId).join(", ")}.` : target.interact ? "Face the target, then press A." : next.length ? `On the exit. Activate with ${next.map(actionId).join(" or ")}; sideways movement on equivalent mats is not a transition.` : "On the exit square; a directional trigger may be required."}`;
      const travelFacts = target.destination === undefined ? [] : this.travel.routeFacts(Number(state.mapId), target.destination);
      return { fact: `${fact}${navigationFact ? ` ${navigationFact}` : towardObjective ? " Leads toward the active supplied milestone." : ""}${travelFacts.length ? ` ${travelFacts.join(" ")}` : ""}`.slice(0, 500), focusMatch,
        length, next, brief: `${target.label} ${at}: shortest route ${length} step(s)${travelFacts.length ? `; ${travelFacts.join(" ")}` : ""}`.slice(0, 500) };
    }).sort((a, b) => (a.length ?? Infinity) - (b.length ?? Infinity));
    for (const route of candidateRoutes.sort((a, b) => Number(Boolean(b.nearbyPickup || b.stepOffWarp && b.focusMatch)) - Number(Boolean(a.nearbyPickup || a.stepOffWarp && a.focusMatch)) || Number(b.focusMatch) - Number(a.focusMatch) || Number(b.towardObjective) - Number(a.towardObjective) || a.length - b.length).slice(0, 20)) {
      this.routes.set(route.id, route);
      actionFacts[route.id] = [route.navigationFact ?? (route.towardObjective ? "A known interaction relates to the active supplied milestone." : "Reachable local destination; relevance depends on the user's goal and constraints."),
        ...(this.focus.attemptFact(Number(state.mapId), route.id) ? [this.focus.attemptFact(Number(state.mapId), route.id)!] : []),
        ...(route.destination === undefined ? [] : this.travel.routeFacts(Number(state.mapId), route.destination))];
    }
    const nearby = this.nearbyPickups();
    decisionGoal = this.preparation?.needsHealing ? `Restore the injured party before routine onward travel or optional fights. ${this.planningActive ? "Choose focus_heal when a new purpose is needed, then an exit that leads closer to a Center and its nurse." : "Use available verified destinations or controller attempts to reach an accessible Center; do not assume an unavailable purpose action."} Opening START is not healing. Supplied constraints remain authoritative.` :
      nearby.length ? `Collect nearby verified loot before routine travel: available pickup action(s) ${nearby.slice(0, 8).join(", ")}. These opportunities apply even with a story, shopping or capture purpose. Each pickup is an attempt until inventory or the live object changes.` :
        this.planningActive && this.preparation?.needsBalls && this.preparation.canBuyBalls && this.preparation.canStoreCapture ? "Obtain capture balls before more wild encounters. Choose capture or shopping preparation, enter a reachable Mart, approach its clerk, then select balls, quantity and price confirmation separately. Routine story travel does not supply missing balls." :
          this.focus.current ? `Continue Jev's selected ${this.focus.current} purpose with a matching reachable destination or interaction. Arrival alone does not perform the task. Reconsider only when current evidence requires it; preserve supplied constraints.` :
            this.planningActive ? "Choose a useful purpose using current preparation needs and supplied objectives, then choose its destination separately." :
              `Complete the current supplied milestone before assuming later capture/shopping prerequisites: ${progress?.objective?.goal ?? "use observed state and available choices to follow the user's objectives"}.`.slice(0, 500);
    const locals = routeFacts.filter(route => route.focusMatch && route.length !== null).map(route => route.length!);
    this.focus.distance(focusGuidance?.here ?? (this.focus.current === "train" || this.focus.current === "catch" ? grassTargets.length ? 0 : undefined : undefined), locals.length ? Math.min(...locals) : undefined);
    if (this.planningActive && focusGuidance?.here === 0) facts.unshift("The current map contains the destination for the selected purpose. Entering it or activating its return exit does not perform the task; inspect relevant people/objects and observed outcomes before leaving, unless Jev deliberately changes purpose.");
    facts.push(...routeFacts.slice(0, 32 - facts.length).map(route => route.fact));
    for (const direction of directions) actionFacts[actionId(direction)]!.push(...routeFacts.filter(route => route.next.includes(direction)).slice(0, 6).map(route => `${route.brief}; ${direction.button} ${route.length === 0 ? "activates this exit" : "starts this route"}.`.slice(0, 500)));
    return finish();
  }

  allows(state: GameState, button: string): boolean {
    if (state.values.movementInProgress === true || state.values.controlBusy === true) return false;
    if (state.values.phase === "overworld") {
      if (button === "B" || button === "SELECT") return false;
      if (state.values[`step${button}`] === "blocked") return false;
    }
    if (state.values.phase === "text" && !["A", "B"].includes(button)) return false;
    if (state.values.menuKind === "overworld" && ["LEFT", "RIGHT", "SELECT"].includes(button)) return false;
    return true;
  }
}

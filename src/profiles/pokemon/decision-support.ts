import type { GameState, StateValue } from "../../core/agent.js";
import type { GameReaderMemory, GameStateData } from "../../core/game-reader.js";
import type { PokemonNavigationLayout } from "./navigation-layout.js";

const directions = [
  { name: "up", button: "UP", dx: 0, dy: -1, facing: 4, connection: 8 },
  { name: "down", button: "DOWN", dx: 0, dy: 1, facing: 0, connection: 4 },
  { name: "left", button: "LEFT", dx: -1, dy: 0, facing: 8, connection: 2 },
  { name: "right", button: "RIGHT", dx: 1, dy: 0, facing: 12, connection: 1 },
] as const;
type Direction = typeof directions[number];
interface Point { readonly x: number; readonly y: number }
interface Target extends Point { readonly label: string; readonly interact: boolean; readonly boulder?: boolean }
const locations: Readonly<Record<number, string>> = {
  0: "Pallet Town", 1: "Viridian City", 2: "Pewter City", 3: "Cerulean City",
  4: "Lavender Town", 5: "Vermilion City", 6: "Celadon City", 7: "Fuchsia City",
  8: "Cinnabar Island", 9: "Indigo Plateau", 10: "Saffron City",
  37: "Player's house, ground floor", 38: "Player's house, upper floor",
  39: "Rival's house", 40: "Oak's laboratory",
};
function location(id: number): string {
  return locations[id] ?? (id >= 12 && id <= 36 ? `Route ${id - 11}` : `map ${id}`);
}
const key = ({ x, y }: Point) => `${x},${y}`;
const actionId = (direction: Direction) => `press_${direction.name}`;

/** Original, profile-local mechanics. Provides facts and routes, never chooses a goal or action. */
export class GenerationOneDecisionSupport {
  // Only immutable cartridge data is cached. RAM, objects, paths, and availability are always fresh.
  private readonly banks = new Map<number, Uint8Array>();
  private readonly layout: PokemonNavigationLayout | undefined;
  constructor(layout?: PokemonNavigationLayout) {
    this.layout = layout ? { ...layout } : undefined;
    if (layout) for (const [name, address] of Object.entries(layout)) {
      if (!Number.isSafeInteger(address) || (name === "collisionBank" ? address < 0 || address > 255 :
          name === "tilePairs" || name === "ledges" ? address < 0 || address >= 8 * 1024 * 1024 : address < 0xc000 || address > 0xdfff)) {
        throw new Error("Invalid Generation I navigation layout.");
      }
    }
  }
  reset(): void { this.banks.clear(); }

  read(memory: GameReaderMemory, ram: Uint8Array, state: Readonly<Record<string, StateValue>>): GameStateData {
    const facts: string[] = [];
    const actionFacts: Record<string, string[]> = {};
    const values: Record<string, StateValue> = {};
    const descriptions: Record<string, string> = {};
    const add = (name: string, value: StateValue, description: string) => { values[name] = value; descriptions[name] = description; };
    if (state.phase === "transition") facts.push("Input is blocked or the display is changing. Wait for a stable screen before selecting another gameplay input.");
    if (state.phase === "text") facts.push("A text box is visible. A advances dialogue; walking controls do not move through the box. Text can still be printing.");
    if (state.phase === "naming") facts.push("This is a naming grid. A enters the highlighted character, B deletes, SELECT changes case, START finishes a nonempty entry. Follow the user's naming constraints.");
    if (state.menuKind === "overworld") {
      facts.push("The START menu manages party, items, saving, and options. Close it with B or START to explore. It cannot provide a starter or move the player.");
      actionFacts.press_a = [state.menuSelectionEffect ? String(state.menuSelectionEffect) : `Confirm the highlighted entry: ${state.menuSelection}.`];
    }
    if (typeof state.mapId === "number") add("locationName", location(state.mapId), "Verified Gen I map identifier; unknown maps retain their numeric ID. Not a progression objective.");
    if (state.partyCount === 0) facts.push("The party is empty. The POKEMON menu has nothing to show. Interacting with people or visible objects can open dialogue; opening START does not obtain a Pokemon.");
    if (state.phase !== "overworld" || !this.layout) return { values, descriptions, decisionSupport: { facts, actionFacts } };

    const layout = this.layout;
    const u8 = (address: number) => ram[address - 0xc000]!;
    const u16 = (address: number) => u8(address) | u8(address + 1) << 8;
    if (u8(layout.walkCounter) > 0) {
      add("movementInProgress", true, "The live walking counter is nonzero; coordinates and collision evidence may still be changing.");
      facts.push("A movement animation is still running. Wait for it to finish; do not treat its current coordinates as a failed step.");
      return { values, descriptions, decisionSupport: { facts, actionFacts } };
    }
    const width = Number(state.mapWidth); const height = Number(state.mapHeight);
    const player = { x: Number(state.playerX), y: Number(state.playerY) };
    const valid = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width % 2 === 0 && height % 2 === 0 &&
      (width / 2 + 6) * (height / 2 + 6) <= 1300 && player.x >= 0 && player.y >= 0 && player.x < width && player.y < height;
    if (!memory.readRom || !valid) {
      facts.push("Collision and route data are unavailable. Controller directions remain attempts; no claim of legal movement is made.");
      return { values, descriptions, decisionSupport: { facts, actionFacts } };
    }
    if (state.movementMode !== "walking" && state.movementMode !== "cycling") {
      add("navigationStatus", "partial", "Walking collision rules do not verify the current movement mode.");
      facts.push("The current movement mode needs different collision rules. Directions remain available attempts; walking routes are not asserted.");
      return { values, descriptions, decisionSupport: { facts, actionFacts } };
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
      return { values, descriptions, decisionSupport: { facts, actionFacts } };
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
      return { values, descriptions, decisionSupport: { facts, actionFacts } };
    }
    const tileset = u8(layout.tileset);
    const tile = (x: number, y: number): number => {
      // The six-block padding includes the border and connected-map strips.
      const bx = Math.floor(x / 2) + 3; const by = Math.floor(y / 2) + 3;
      if (bx < 0 || by < 0 || bx >= width / 2 + 6 || by >= height / 2 + 6) return -1;
      const block = u8(0xc6e8 + by * (width / 2 + 6) + bx);
      const quadrant = ((y & 1) * 2 + 1) * 4 + (x & 1) * 2;
      return romByte(flat(blockPointer) + block * 16 + quadrant);
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
      const boulder = u8(0xc100 + index * 16) === 0x3f;
      if (inside(point)) objects.push({ ...point, label: `${boulder ? "Boulder" : "Object"} ${index}`, interact: true, boulder });
    }
    const occupied = new Set(objects.map(key));
    const warps: Target[] = [];
    for (let index = 0; index < Math.min(u8(layout.warpCount), 32); index++) {
      const address = layout.warps + index * 4;
      const point = { x: u8(address + 1), y: u8(address) };
      const raw = u8(address + 3); const destination = raw === 0xff ? u8(layout.lastMap) : raw;
      if (inside(point)) warps.push({ ...point, label: `Exit ${index + 1} to ${location(destination)}`, interact: false });
    }
    const warpKeys = new Set(warps.map(key));
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
    }
    const facing = directions.find(direction => direction.name === state.facing);
    const front = facing ? { x: player.x + facing.dx, y: player.y + facing.dy } : undefined;
    const signs: Target[] = [];
    for (let index = 0; index < Math.min(u8(layout.signCount), 16); index++) {
      const point = { x: u8(layout.signs + index * 2 + 1), y: u8(layout.signs + index * 2) };
      if (inside(point)) signs.push({ ...point, label: `Sign ${index + 1}`, interact: true });
    }
    const interactable = [...objects, ...signs];
    const ahead = front ? interactable.find(target => key(target) === key(front) || facing && counters.has(tile(front.x, front.y)) &&
      target.x === front.x + facing.dx && target.y === front.y + facing.dy) : undefined;
    actionFacts.press_a = [ahead ? `Facing ${ahead.label} at (${ahead.x},${ahead.y}). A interacts with it.` : "No decoded object or sign is in front. A may examine background scenery; it does not walk or open START."];
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
      if (!target.interact) return [target];
      return directions.flatMap(direction => {
        const point = { x: target.x - direction.dx, y: target.y - direction.dy };
        const goals = [point];
        if (counters.has(tile(point.x, point.y))) goals.push({ x: point.x - direction.dx, y: point.y - direction.dy });
        return goals;
      }).filter(inside);
    };
    const targets = [...warps, ...objects.slice(0, 10), ...signs.slice(0, 4)];
    for (const direction of directions) if (connectionMask & direction.connection) {
      const candidates: Point[] = [];
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const point = { x, y }; const result = step(point, direction);
        if (distance[indexOf(point)]! >= 0 && result.allowed && !inside(result.point)) candidates.push(point);
      }
      candidates.sort((a, b) => distance[indexOf(a)]! - distance[indexOf(b)]!);
      const exit = candidates[0];
      if (exit) targets.push({ ...exit, label: `${direction.name} boundary to ${location(u8(layout.connections + 1 + directions.indexOf(direction) * 11))}`, interact: false });
    }
    const routeFacts = targets.map(target => {
      const goals = goalsFor(target).filter(point => distance[indexOf(point)]! >= 0);
      const length = goals.length ? Math.min(...goals.map(point => distance[indexOf(point)]!)) : null;
      const best = length === null ? [] : goals.filter(point => distance[indexOf(point)] === length);
      const mask = best.reduce((bits, point) => bits | first[indexOf(point)]!, 0);
      const next = directions.filter((_direction, index) => mask & 1 << index);
      const at = `(${target.x},${target.y})`;
      const fact = length === null ? `${target.label} at ${at}: no route found with current walking rules and objects; special mechanics may be needed.` :
        `${target.label} at ${at}: ${length} local step(s) ${target.interact ? "to an interaction position" : "to the exit"}. ${length ? `Shortest first inputs: ${next.map(actionId).join(", ")}.` : target.interact ? "Face the target, then press A." : "On the exit square; a directional trigger may be required."}`;
      return { fact, length, next, brief: `${target.label} ${at}: shortest route ${length} step(s)` };
    }).sort((a, b) => (a.length ?? Infinity) - (b.length ?? Infinity));
    facts.push(...routeFacts.slice(0, 32 - facts.length).map(route => route.fact));
    for (const direction of directions) actionFacts[actionId(direction)]!.push(...routeFacts.filter(route => route.next.includes(direction)).slice(0, 6).map(route => `${route.brief}; ${direction.button} starts this route.`));
    return { values, descriptions, decisionSupport: { facts, actionFacts } };
  }

  allows(state: GameState, button: string): boolean {
    if (state.values.movementInProgress === true) return false;
    if (state.values.phase === "overworld") {
      if (button === "B" || button === "SELECT") return false;
      if (state.values[`step${button}`] === "blocked") return false;
    }
    if (state.values.phase === "text" && !["A", "B"].includes(button)) return false;
    if (state.values.menuKind === "overworld" && ["LEFT", "RIGHT", "SELECT"].includes(button)) return false;
    return true;
  }
}

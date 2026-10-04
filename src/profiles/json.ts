import { readFile, stat } from "node:fs/promises";
import type { GameReader, GameReaderDescriptor, GameStateData } from "../core/game-reader.js";
import type { AgentAction, GameState, Objectives, StateValue } from "../core/agent.js";
import type { MemoryReader } from "../core/emulator.js";
import { parseObjectives } from "../config/objectives.js";

type FieldType = "u8" | "i8" | "u16le" | "u16be" | "flag" | "enum";
interface Field { name: string; description: string; address: number; type: FieldType; mask: number; labels: Readonly<Record<string, string>> }
interface Condition { field: string; op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; value: StateValue }
interface ActionRule { id: string; description: string; buttons: readonly string[]; frames: number | undefined; when: readonly Condition[] }

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Invalid profile object or unknown property.");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error("Profile strings must be nonempty and bounded.");
  return value;
}
function integer(value: unknown, maximum: number): number {
  if (typeof value === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error("Invalid profile integer or address.");
  return value;
}
function array(value: unknown, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error("Invalid profile list length.");
  return value;
}

/** Declarative Strategy implementation for simple byte, word, flag, and enum layouts. */
export class JsonGameReader implements GameReader {
  constructor(readonly descriptor: GameReaderDescriptor, private readonly fields: readonly Field[], private readonly rules: readonly ActionRule[] | undefined,
    readonly defaultObjectives?: Objectives) {}

  readState(memory: MemoryReader): GameStateData {
    const values: Record<string, StateValue> = {};
    const descriptions: Record<string, string> = {};
    for (const field of this.fields) {
      const bytes = memory.readMemory(field.address, field.type.startsWith("u16") ? 2 : 1);
      const byte = bytes[0]!;
      let value: StateValue = byte;
      if (field.type === "i8") value = byte > 127 ? byte - 256 : byte;
      if (field.type === "u16le") value = byte + bytes[1]! * 256;
      if (field.type === "u16be") value = byte * 256 + bytes[1]!;
      if (field.type === "flag") value = (byte & field.mask) !== 0;
      if (field.type === "enum") value = field.labels[String(byte)] ?? byte;
      values[field.name] = value; descriptions[field.name] = field.description;
    }
    return { values, descriptions };
  }

  availableActions(state: GameState, defaults: readonly AgentAction[]): readonly AgentAction[] {
    if (this.rules === undefined) return defaults;
    const matches = (condition: Condition): boolean => {
      const actual = state.values[condition.field];
      switch (condition.op) {
        case "eq": return actual === condition.value;
        case "ne": return actual !== condition.value;
        case "lt": return typeof actual === "number" && typeof condition.value === "number" && actual < condition.value;
        case "lte": return typeof actual === "number" && typeof condition.value === "number" && actual <= condition.value;
        case "gt": return typeof actual === "number" && typeof condition.value === "number" && actual > condition.value;
        case "gte": return typeof actual === "number" && typeof condition.value === "number" && actual >= condition.value;
      }
    };
    const duration = defaults.find((action) => action.id === "wait")!.frames;
    return [...this.rules.filter((rule) => rule.when.every(matches)).map((rule) => ({
      id: rule.id, description: rule.description, buttons: rule.buttons, frames: rule.frames ?? duration, stop: false,
    })), ...defaults.filter((action) => action.id === "wait" || action.stop)];
  }
}

export function parseJsonGameReader(value: unknown): GameReader {
  const root = record(value, ["schemaVersion", "id", "name", "consoleId", "romSha256", "fields", "actions", "defaultObjectives"]);
  if (root.schemaVersion !== 1) throw new Error("Unsupported game-profile schema version.");
  const descriptor: GameReaderDescriptor = { id: text(root.id, 64), name: text(root.name, 100), consoleId: text(root.consoleId, 64),
    romSha256: array(root.romSha256, 1, 32).map((hash) => text(hash, 64)) };
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(descriptor.id) || !/^[a-z][a-z0-9-]{0,63}$/.test(descriptor.consoleId) || descriptor.romSha256.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) throw new Error("Invalid profile identifier, console, or ROM hash.");
  const names = new Set<string>();
  const fields: Field[] = array(root.fields, 1, 64).map((value) => {
    const entry = record(value, ["name", "description", "address", "type", "mask", "labels"]);
    const name = text(entry.name, 64);
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) || names.has(name)) throw new Error("Profile fields require unique names.");
    names.add(name);
    const type = text(entry.type, 8) as FieldType;
    if (!["u8", "i8", "u16le", "u16be", "flag", "enum"].includes(type)) throw new Error("Unsupported profile field type.");
    if (entry.mask !== undefined && type !== "flag" || entry.labels !== undefined && type !== "enum") throw new Error("Masks are for flags and labels are for enum fields.");
    const mask = type === "flag" ? integer(entry.mask, 255) : 0;
    if (type === "flag" && !mask) throw new Error("Flag masks must be nonzero.");
    const labels: Record<string, string> = {};
    if (type === "enum") {
      if (!entry.labels || typeof entry.labels !== "object" || Array.isArray(entry.labels) || Object.keys(entry.labels).length < 1 || Object.keys(entry.labels).length > 256) throw new Error("Enum fields require byte-to-label mappings.");
      for (const [key, label] of Object.entries(entry.labels)) {
        const byte = integer(key, 255);
        if (Object.hasOwn(labels, String(byte))) throw new Error("Duplicate enum byte values.");
        labels[String(byte)] = text(label, 256);
      }
    }
    return { name, description: text(entry.description), address: integer(entry.address, 0xffffffff), type, mask, labels };
  });
  const ids = new Set<string>(["wait", "stop"]);
  const rules = root.actions === undefined ? undefined : array(root.actions, 0, 253).map((value): ActionRule => {
    const entry = record(value, ["id", "description", "buttons", "frames", "when"]);
    const id = text(entry.id, 64);
    if (!/^[a-zA-Z][a-zA-Z0-9_:-]{0,63}$/.test(id) || ids.has(id)) throw new Error("Profile actions require unique IDs; wait and stop are reserved.");
    ids.add(id);
    const frames = entry.frames === undefined ? undefined : integer(entry.frames, 600);
    if (frames === 0) throw new Error("Profile action durations must be positive.");
    const when = array(entry.when ?? [], 0, 16).map((value): Condition => {
      const condition = record(value, ["field", "op", "value"]);
      const field = text(condition.field, 64);
      const op = text(condition.op, 3) as Condition["op"];
      if (!names.has(field) || !["eq", "ne", "lt", "lte", "gt", "gte"].includes(op)) throw new Error("Invalid action condition field or operator.");
      const compared = condition.value;
      if (!(typeof compared === "string" && compared.length <= 256 || typeof compared === "number" && Number.isFinite(compared) || typeof compared === "boolean")) throw new Error("Invalid action condition value.");
      if (op !== "eq" && op !== "ne" && typeof compared !== "number") throw new Error("Ordered conditions require numeric values.");
      return { field, op, value: compared };
    });
    return { id, description: text(entry.description), buttons: array(entry.buttons, 0, 32).map((button) => text(button, 64)), frames, when };
  });
  return new JsonGameReader(descriptor, fields, rules, root.defaultObjectives === undefined ? undefined : parseObjectives(root.defaultObjectives));
}

export async function loadJsonGameReader(path: string): Promise<GameReader> {
  if ((await stat(path)).size > 131_072) throw new Error("Game profiles must be at most 128 KiB.");
  return parseJsonGameReader(JSON.parse(await readFile(path, "utf8")) as unknown);
}

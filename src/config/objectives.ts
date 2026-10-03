import { readFile, stat } from "node:fs/promises";
import type { Objectives } from "../core/agent.js";

export function parseObjectives(value: unknown, allowEmptyGoal = false): Objectives {
  if (!value || typeof value !== "object" || !("goal" in value) ||
      typeof value.goal !== "string" || (!allowEmptyGoal && !value.goal.trim()) || value.goal.length > 2000) {
    throw new Error("Objectives must contain a nonempty goal of at most 2,000 characters.");
  }
  const list = (name: "constraints" | "milestones"): string[] => {
    const entries = name in value ? (value as Record<string, unknown>)[name] : [];
    if (!Array.isArray(entries) || entries.length > 16 || entries.some((entry: unknown) =>
      typeof entry !== "string" || !entry.trim() || entry.length > 500)) {
      throw new Error(`Objectives ${name} must contain at most 16 nonempty strings of at most 500 characters.`);
    }
    return entries.map((entry: string) => entry.trim());
  };
  return { goal: value.goal.trim(), constraints: list("constraints"), milestones: list("milestones") };
}

export async function loadObjectives(path: string): Promise<Objectives> {
  if ((await stat(path)).size > 32_768) throw new Error("Objectives files must be at most 32 KiB.");
  return parseObjectives(JSON.parse(await readFile(path, "utf8")) as unknown);
}

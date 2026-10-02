import type { AgentSettings } from "../core/agent.js";
import { parseObjectives } from "./objectives.js";

export function parseSessionLimit(value: unknown, name: string, maximum: number): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}, or null for unlimited.`);
  }
  return value;
}

/** Validate the entire update before changing the running session. */
export function parseAgentSettings(value: unknown): AgentSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent settings.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !["objectives", "maxDecisions", "maxRequests", "maxSeconds", "actionFrames"].includes(key))) {
    throw new Error("Unknown agent setting.");
  }
  const actionFrames = parseSessionLimit(data.actionFrames, "Action frames", 600);
  if (actionFrames === null) throw new Error("Action frames must remain bounded.");
  return { objectives: parseObjectives(data.objectives), actionFrames,
    maxDecisions: parseSessionLimit(data.maxDecisions, "Decision limit", 10_000),
    maxRequests: parseSessionLimit(data.maxRequests, "Request limit", 10_000),
    maxSeconds: parseSessionLimit(data.maxSeconds, "Session seconds", 86_400) };
}

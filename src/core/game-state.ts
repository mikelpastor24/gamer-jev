import type { GameState } from "./agent.js";

export function validateGameState(state: GameState, frame: number): void {
  if (!state || state.frame !== frame || typeof state.source !== "string" || !state.source || state.source.length > 100 ||
      !state.values || !state.descriptions || typeof state.values !== "object" || typeof state.descriptions !== "object" ||
      Array.isArray(state.values) || Array.isArray(state.descriptions) || Object.keys(state.values).length > 64) throw new Error("Invalid structured game state.");
  for (const [name, value] of Object.entries(state.values)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) ||
        !(typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 256)) {
      throw new Error("Game-state fields require stable names and bounded primitive values.");
    }
  }
  for (const [name, description] of Object.entries(state.descriptions)) {
    if (!Object.hasOwn(state.values, name) || typeof description !== "string" || description.length > 500) throw new Error("Invalid game-state field description.");
  }
  if (state.decisionSupport !== undefined) {
    const support = state.decisionSupport;
    const validFacts = (facts: unknown, maximum: number) => Array.isArray(facts) && facts.length <= maximum &&
      facts.every((fact: unknown) => typeof fact === "string" && fact.length > 0 && fact.length <= 500);
    if (!support || typeof support !== "object" || !validFacts(support.facts, 32) ||
        !support.actionFacts || typeof support.actionFacts !== "object" || Array.isArray(support.actionFacts) ||
        Object.keys(support.actionFacts).length > 32 || Object.entries(support.actionFacts).some(([id, facts]) =>
          !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id) || !validFacts(facts, 8))) {
      throw new Error("Invalid bounded game decision support.");
    }
  }
}

import { createHash } from "node:crypto";
import type { ActionRecord, ActionResult, DecisionFeedback, GameState, StateValue } from "../core/agent.js";

const WINDOW = 32;
const boundedValue = (value: StateValue | undefined): StateValue | null =>
  typeof value === "string" && value.length > 128 ? `${value.slice(0, 125)}...` : value ?? null;

/** Compare actual execution frames without interpreting any game's fields or choosing controls. */
export function actionResult(frame: number, screenChanged: boolean, before?: GameState, after?: GameState): ActionResult {
  const comparable = before !== undefined && after !== undefined && before.source === after.source;
  const fields = comparable ? [...new Set([...Object.keys(before.values), ...Object.keys(after.values)])]
    .filter((name) => before.values[name] !== after.values[name]) : [];
  return { frame, screenChanged, stateChanged: comparable ? fields.length > 0 : null, changedFieldCount: fields.length,
    changes: fields.slice(0, 12).map((field) => ({ field, before: boundedValue(before!.values[field]), after: boundedValue(after!.values[field]) })) };
}

/** Detect recurring observations, including cycles that alternate between several screens. */
export class AgentFeedbackTracker {
  private samples: { fingerprint: string; source: string | undefined; values: GameState["values"] | undefined }[] = [];

  reset(): void { this.samples = []; }

  observe(state: GameState | undefined, screenHash: string, history: readonly ActionRecord[]): DecisionFeedback {
    const fingerprint = state ? createHash("sha256").update(JSON.stringify({ source: state.source,
      values: Object.entries(state.values).sort(([first], [second]) => first.localeCompare(second)) })).digest("hex") : screenHash;
    const sample = { fingerprint, source: state?.source, values: state ? structuredClone(state.values) : undefined };
    this.samples.push(sample); this.samples = this.samples.slice(-WINDOW);
    const recent = this.samples.slice(-12);
    let unchanged = 0;
    for (let index = this.samples.length - 2; index >= 0 && this.samples[index]!.fingerprint === fingerprint; index--) unchanged++;
    let withoutChange = 0;
    for (const action of [...history].reverse()) {
      if (action.interrupted || !action.result || !(action.result.stateChanged === false || action.result.stateChanged === null && !action.result.screenChanged)) break;
      withoutChange++;
    }
    const ids = history.slice(history.findLastIndex((action) => action.interrupted) + 1).map((action) => action.actionId);
    let cycle: readonly string[] = [], repetitions = 0;
    for (let length = 1; length <= Math.min(6, Math.floor(ids.length / 2)); length++) {
      const candidate = ids.slice(-length);
      let count = 1;
      while (ids.length >= (count + 1) * length && candidate.every((id, offset) => id === ids[ids.length - (count + 1) * length + offset])) count++;
      if (count >= 2) { cycle = candidate; repetitions = count; break; }
    }
    const stable = state && recent.length > 1 ? Object.entries(state.values).filter(([name, value]) =>
      recent.every((entry) => entry.source === state.source && entry.values?.[name] === value)).slice(0, 32) : [];
    return { basis: state ? "structured-state" : "screen", windowObservations: this.samples.length,
      repeatedStateVisits: this.samples.filter((entry) => entry.fingerprint === fingerprint).length,
      consecutiveUnchangedStates: unchanged, consecutiveActionsWithoutChange: withoutChange,
      repeatedActionCycle: cycle, cycleRepetitions: repetitions,
      stableFields: Object.fromEntries(stable.map(([name, value]) => [name, boundedValue(value)!])) };
  }
}

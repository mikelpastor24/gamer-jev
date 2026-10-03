import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionRecord, DecisionContext, GameState, GameStateProvider } from "../src/core/agent.js";
import type { EmulatorAction } from "../src/core/emulator.js";
import { controllerActions } from "../src/core/actions.js";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { createTypeSafeDecisionProvider } from "../src/jev/typesafe.js";
import { createStateObserver } from "../src/observation/state.js";
import { RequestBudget } from "../src/providers/requests.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { runAgentHeadless } from "../src/runner/agent-headless.js";
import { actionResult, AgentFeedbackTracker } from "../src/runner/feedback.js";

const state = (frame: number, phase = "world", position = 0): GameState => ({ source: "fixture", frame,
  values: { phase, position, inventory: 0 }, descriptions: {} });
const record = (actionId: string, interrupted = false): ActionRecord => ({ actionId, fromFrame: 0, toFrame: 4,
  observation: "Fixture", interrupted, ...(!interrupted ? { result: actionResult(4, true, state(0), state(4)) } : {}) });

test("recurring semantic states survive menu toggles, frame changes, and animated pixels", () => {
  const tracker = new AgentFeedbackTracker();
  const history = ["press_start", "press_b", "press_up", "press_start", "press_b", "press_up"].map((id) => record(id));
  for (const [index, phase] of ["world", "menu", "world", "world", "menu", "world"].entries()) tracker.observe(state(index * 30, phase), `different-pixels-${index}`, history.slice(0, index));
  const feedback = tracker.observe(state(180), "another-animation", history);
  assert.equal(feedback.basis, "structured-state"); assert.equal(feedback.repeatedStateVisits, 5);
  assert.deepEqual(feedback.repeatedActionCycle, ["press_start", "press_b", "press_up"]); assert.equal(feedback.cycleRepetitions, 2);
  assert.deepEqual(feedback.stableFields, { position: 0, inventory: 0 });
  assert.equal(feedback.consecutiveActionsWithoutChange, 6, "Pixel animation must not hide unchanged semantic values.");
  const moved = tracker.observe(state(200, "world", 1), "new-pixels", history);
  assert.equal(moved.repeatedStateVisits, 1); assert.equal(moved.stableFields.position, undefined);
});

test("feedback is bounded, ignores field order, and resets on a new timeline without bridging interruptions", () => {
  const tracker = new AgentFeedbackTracker();
  for (let frame = 0; frame < 70; frame++) tracker.observe(state(frame), "pixels", []);
  const ordered = { ...state(80), values: { inventory: 0, position: 0, phase: "world" } };
  const feedback = tracker.observe(ordered, "different-pixels", [record("press_a"), record("press_a", true), record("press_a")]);
  assert.equal(feedback.windowObservations, 32); assert.equal(feedback.repeatedStateVisits, 32);
  assert.equal(feedback.consecutiveUnchangedStates, 31); assert.deepEqual(feedback.repeatedActionCycle, []);
  assert.equal(feedback.consecutiveActionsWithoutChange, 1);
  tracker.reset();
  const reset = tracker.observe(state(0), "pixels", []);
  assert.equal(reset.windowObservations, 1); assert.equal(reset.repeatedStateVisits, 1);
  assert.equal(reset.consecutiveUnchangedStates, 0); assert.deepEqual(reset.stableFields, {});
});

test("action results retain bounded added/removed fields and do not treat frame numbers as changes", () => {
  assert.equal(actionResult(30, false, state(0), state(30)).stateChanged, false);
  const before: GameState = { ...state(0), values: { removed: 3, ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, "a".repeat(256)])) } };
  const after: GameState = { ...state(4), values: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, "b".repeat(256)])) };
  const result = actionResult(4, true, before, after);
  assert.equal(result.changedFieldCount, 21); assert.equal(result.changes.length, 12);
  assert.deepEqual(result.changes[0], { field: "removed", before: 3, after: null });
  assert.ok(result.changes.every((change) => typeof change.after !== "string" || change.after.length <= 128));
  assert.deepEqual(actionResult(4, false), { frame: 4, screenChanged: false, stateChanged: null, changedFieldCount: 0, changes: [] });
  const feedback = new AgentFeedbackTracker().observe(undefined, "pixels", [record("wait"), { ...record("wait"), result: actionResult(4, false) }]);
  assert.equal(feedback.basis, "screen"); assert.deepEqual(feedback.stableFields, {});
});

/** Original demo cartridge plus invented semantic states; no commercial game data. */
class FeedbackEmulator extends GameBoyEmulator {
  phase = "world";
  position = 0;
  override advance(action: EmulatorAction) {
    super.advance(action);
    if (action.buttons.includes("START")) this.phase = this.phase === "world" ? "menu" : "world";
    if (action.buttons.includes("B")) this.phase = "world";
    if (action.buttons.includes("RIGHT") && this.phase === "world") this.position++;
  }
}

test("direct Jev receives action outcomes and menu-cycle evidence, preserves its choices, and clears feedback on restore", async () => {
  const emulator = new FeedbackEmulator(createDemoRom());
  const sequence = ["press_start", "press_b", "press_up", "press_start", "press_b", "press_up", "press_right", "wait"];
  const contexts: DecisionContext[] = [], events: unknown[] = [];
  const provider: GameStateProvider = { id: "fixture", read(frame) {
    return { state: state(frame.number, emulator.phase, emulator.position), actions: controllerActions(emulator.descriptor.buttons, 2) };
  } };
  const budget = new RequestBudget({ maxRequests: 10, timeoutMs: 1000, intervalMs: 0, retries: 0 });
  const decider = createTypeSafeDecisionProvider({ apiKey: "private-feedback-fixture", model: "jev-latest", budget, async fetch(_url, init) {
    const request = JSON.parse(String(init?.body)); const context = request.state as DecisionContext; contexts.push(context);
    assert.match(request.questions.next_action.instructions, /history.result.*feedback/);
    const selected = sequence[(contexts.length - 1) % sequence.length]!;
    return Response.json({ model: "jev-latest", usage: { input_tokens: 1, output_tokens: 1 },
      answers: { next_action: { type: "choice", choice: selected, confidence: 1,
        probabilities: Object.fromEntries(context.actions.map((action) => [action.id, action.id === selected ? 1 : 0])) } } });
  } });
  const session = new AgentSession(emulator, { mode: "typesafe", visionProvider: "none", observer: createStateObserver(provider), decider, budget,
    objectives: { goal: "Explore the fixture", constraints: [], milestones: [] }, actionFrames: 2, maxDecisions: 8, maxSeconds: 60, record: (event) => events.push(event) });
  try {
    await runAgentHeadless(emulator, session, new AbortController().signal);
    const stuck = contexts[6]!;
    assert.deepEqual(stuck.feedback!.repeatedActionCycle, ["press_start", "press_b", "press_up"]);
    assert.equal(stuck.feedback!.cycleRepetitions, 2); assert.ok(stuck.feedback!.repeatedStateVisits >= 3);
    assert.equal(stuck.feedback!.stableFields.position, 0);
    assert.equal(stuck.history.at(-1)!.result!.stateChanged, false);
    assert.ok(stuck.history.some((action) => action.result!.changes.some((change) => change.field === "phase" && change.after === "menu")));
    const moved = contexts[7]!;
    assert.equal(moved.gameState!.values.position, 1); assert.equal(moved.feedback!.repeatedStateVisits, 1);
    assert.deepEqual(moved.history.at(-1)!.result!.changes, [{ field: "position", before: 0, after: 1 }]);
    const actions = events.filter((event) => (event as { type: string }).type === "action") as ActionRecord[];
    assert.deepEqual(actions.map((action) => action.actionId), sequence);
    assert.ok(actions.every((action) => action.result!.frame === action.toFrame)); assert.equal(budget.requests, 8);
    const saved = emulator.saveState(); emulator.restoreState(saved);
    session.updateSettings({ ...session.copySettings(), maxDecisions: 9 }, session.configuration.revision);
    session.clearHistory(); session.resume(); session.tick(1); await session.waitForPending();
    assert.equal(contexts[8]!.feedback!.windowObservations, 1); assert.equal(contexts[8]!.feedback!.repeatedStateVisits, 1);
    assert.deepEqual(contexts[8]!.history, []);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("continuous action results compare execution states, excluding changes that occurred while waiting for Jev", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  let complete!: (value: import("../src/core/agent.js").Decision) => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const events: unknown[] = [];
  const observer = createStateObserver({ id: "fixture", read(frame) {
    return { state: { ...state(frame.number), values: { clock: frame.number } }, actions: controllerActions(emulator.descriptor.buttons, 4) };
  } });
  const session = new AgentSession(emulator, { mode: "mock", observer, objectives: { goal: "Observe timing", constraints: [], milestones: [] },
    decider: { decide() { started(); return new Promise((resolve) => { complete = resolve; }); } }, budget: new RequestBudget({ maxRequests: 1, timeoutMs: 1000, intervalMs: 0, retries: 0 }),
    actionFrames: 4, maxDecisions: 1, maxSeconds: 60, record: (event) => events.push(event) });
  try {
    session.tick(2, true); await began; session.tick(20, true);
    complete({ actionId: "wait", model: "fixture", confidence: null, probabilities: {}, usage: { inputTokens: 0, outputTokens: 0 } });
    await session.waitForPending(); session.tick(10, true);
    const action = events.find((event) => (event as { type: string }).type === "action") as ActionRecord;
    assert.equal(action.fromFrame, 22); assert.equal(action.toFrame, 26);
    assert.deepEqual(action.result!.changes, [{ field: "clock", before: 22, after: 26 }]);
    assert.equal(action.result!.frame, 26);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

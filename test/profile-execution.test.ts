import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentAction, CompletedGameAction, GameActionExecution, ObservationProvider, StateSnapshot } from "../src/core/agent.js";
import type { Emulator, EmulatorAction, EmulatorState } from "../src/core/emulator.js";
import { GAME_BOY_DESCRIPTOR } from "../src/emulator/game-boy/game-boy-emulator.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { RequestBudget } from "../src/providers/requests.js";
import { runAgentHeadless } from "../src/runner/agent-headless.js";
import { withVision } from "../src/observation/combined.js";
import { validateAgentActions } from "../src/core/actions.js";

class FrameFixture implements Emulator {
  readonly descriptor = GAME_BOY_DESCRIPTOR;
  readonly rom = { title: "Execution fixture", sha256: "a".repeat(64), byteLength: 0 };
  frameNumber = 0;
  readonly inputs: EmulatorAction[] = [];
  advance(action: EmulatorAction) { this.inputs.push(structuredClone(action)); this.frameNumber += action.frames; }
  captureFrame() { return { number: this.frameNumber, width: 1, height: 1, format: "rgba8888" as const, pixels: new Uint8Array(4) }; }
  saveState(): EmulatorState { return { schemaVersion: 1, consoleId: "game-boy", backendId: "fixture", backendVersion: "1", romSha256: this.rom.sha256, frame: this.frameNumber, payload: null }; }
  restoreState(value: unknown) { this.frameNumber = (value as EmulatorState).frame; }
  reset() { this.frameNumber = 0; }
  dispose() {}
}

const target: AgentAction = { id: "approach_target", description: "Approach the selected fixture target.", buttons: [], frames: 20, stop: false, execution: "profile", availabilityKey: "target-one" };
const goal = { goal: "Approach a fixture target", constraints: [], milestones: [] };
function setup(execution: GameActionExecution, options: { frames?: number; shouldWait?: (frame: number) => boolean; missingExecutor?: boolean; setObjectives?: ObservationProvider["setObjectives"]; onActionComplete?: ObservationProvider["onActionComplete"] } = {}) {
  const emulator = new FrameFixture();
  const records: Record<string, unknown>[] = [];
  let observations = 0, decisions = 0;
  const actions = [{ ...target, frames: options.frames ?? target.frames }];
  const read = (): StateSnapshot => ({ state: { source: "fixture", frame: emulator.frameNumber, values: { clock: emulator.frameNumber }, descriptions: {} }, actions });
  const observer: ObservationProvider = { kind: "state", readSnapshot: read,
    ...(options.setObjectives ? { setObjectives: options.setObjectives } : {}),
    ...(options.onActionComplete ? { onActionComplete: options.onActionComplete } : {}),
    ...(options.shouldWait ? { shouldWait: (frame) => options.shouldWait!(frame.number) } : {}),
    ...(options.missingExecutor ? {} : { createExecution: () => execution }),
    async observe() { observations++; const snapshot = read(); return { text: "A fixture target is visible.", model: "fixture", usage: { inputTokens: 0, outputTokens: 0 }, gameState: snapshot.state, actions: snapshot.actions }; },
  };
  const session = new AgentSession(emulator, { mode: "mock", objectives: goal, observer,
    budget: new RequestBudget({ maxRequests: 1, intervalMs: 0, retries: 0, timeoutMs: 1000 }),
    actionFrames: 8, maxDecisions: 1, maxSeconds: 60, record: event => records.push(event as Record<string, unknown>),
    decider: { async decide() { decisions++; return { actionId: target.id, model: "fixture", confidence: 1, probabilities: {}, usage: { inputTokens: 0, outputTokens: 0 } }; } },
  });
  return { emulator, session, records, observer, counts: () => ({ observations, decisions }) };
}

test("a model-selected profile action executes validated steps and records its actual frames and outcome", async () => {
  let next = 0;
  const reasons: string[] = [];
  const fixture = setup({ next() { return next++ < 5 ? { done: false, buttons: ["RIGHT"] } : { done: true, reason: "Destination reached." }; }, finish: reason => reasons.push(reason) });
  try {
    await runAgentHeadless(fixture.emulator, fixture.session, new AbortController().signal);
    assert.deepEqual(fixture.counts(), { observations: 1, decisions: 1 });
    assert.equal(fixture.emulator.frameNumber, 9);
    assert.equal(fixture.emulator.inputs.filter(input => input.buttons.includes("RIGHT")).length, 5);
    assert.deepEqual(reasons, ["Destination reached."]);
    const action = fixture.records.find(record => record.type === "action")!;
    assert.equal(action.actionId, target.id); assert.equal(action.fromFrame, 0); assert.equal(action.toFrame, 9);
    assert.equal(action.executionReason, "Destination reached.");
  } finally { fixture.session.stop("Test finished."); }
});

test("profile feedback receives actual before/after frames through optional vision and reports cancellation once", async () => {
  const outcomes: CompletedGameAction[] = [];
  const fixture = setup({ next: () => ({ done: true, reason: "Selected purpose stored without input." }) },
    { onActionComplete: event => outcomes.push(event) });
  const combined = withVision(fixture.observer, { async observe() { return { text: "Fixture", model: "fixture", usage: { inputTokens: 0, outputTokens: 0 } }; } });
  fixture.session.setProviders({ mode: "mock", observer: combined, decider: { async decide() {
    return { actionId: target.id, confidence: null, probabilities: {}, model: "fixture", usage: { inputTokens: 0, outputTokens: 0 } };
  } } }); fixture.session.resume();
  try {
    await runAgentHeadless(fixture.emulator, fixture.session, new AbortController().signal);
    assert.equal(outcomes.length, 1); assert.equal(outcomes[0]!.action.id, target.id);
    assert.equal(outcomes[0]!.record.fromFrame, 0); assert.equal(outcomes[0]!.record.toFrame, 4);
    assert.equal(outcomes[0]!.before!.values.clock, 0); assert.equal(outcomes[0]!.after!.values.clock, 4);
    assert.ok(fixture.emulator.inputs.every(input => input.buttons.length === 0));
  } finally { fixture.session.stop("Test finished."); }
  const cancelled = setup({ next: () => ({ done: false, buttons: ["UP"] }) }, { onActionComplete: event => outcomes.push(event) });
  try {
    cancelled.session.tick(1); await cancelled.session.waitForPending(); cancelled.session.tick(3);
    cancelled.session.pause(); cancelled.session.pause(); cancelled.session.stop("Test cancellation.");
    assert.equal(outcomes.length, 2); assert.equal(outcomes[1]!.record.interrupted, true);
    assert.equal(outcomes[1]!.record.toFrame, 3); assert.equal(outcomes[1]!.after, undefined);
  } finally { cancelled.session.stop("Test finished."); }
});

test("objective edits cancel a selected target and update the reader without resetting counters", async () => {
  const reasons: string[] = [], goals: string[] = [];
  const fixture = setup({ next: () => ({ done: false, buttons: ["LEFT"] }), finish: reason => reasons.push(reason) },
    { setObjectives: objectives => goals.push(objectives.goal) });
  try {
    fixture.session.tick(1); await fixture.session.waitForPending(); fixture.session.tick(5);
    fixture.session.updateSettings({ ...fixture.session.copySettings(), maxDecisions: 2,
      objectives: { goal: "Use a different target", constraints: ["Avoid the previous target"], milestones: [] } }, 0);
    fixture.session.tick(100);
    assert.equal(fixture.session.snapshot.state, "paused"); assert.equal(fixture.session.snapshot.decisions, 1);
    assert.equal(fixture.emulator.frameNumber, 5); assert.deepEqual(reasons, ["Profile action cancelled."]);
    assert.deepEqual(goals, [goal.goal, "Use a different target"]);
    assert.throws(() => fixture.session.updateSettings(fixture.session.copySettings(), 0), /another window/);
  } finally { fixture.session.stop("Test finished."); }
});

test("local settling skips both providers, is frame-bounded, and propagates through optional vision", async () => {
  let next = 0;
  const fixture = setup({ next() { return { done: true, reason: "No movement needed." }; } }, { shouldWait: frame => frame < 6 });
  let visionCalls = 0;
  const combined = withVision(fixture.observer, { async observe() { visionCalls++; return { text: "Fixture target", model: "fixture", usage: { inputTokens: 0, outputTokens: 0 } }; } });
  fixture.session.setProviders({ mode: "mock", observer: combined, decider: { async decide() { next++; return { actionId: target.id, confidence: null, probabilities: {}, model: "fixture", usage: { inputTokens: 0, outputTokens: 0 } }; } } });
  fixture.session.resume();
  try {
    fixture.session.tick(3); fixture.session.tick(3);
    assert.equal(fixture.emulator.frameNumber, 6); assert.equal(next, 0); assert.equal(visionCalls, 0);
    await runAgentHeadless(fixture.emulator, fixture.session, new AbortController().signal);
    assert.equal(next, 1); assert.equal(visionCalls, 1);
  } finally { fixture.session.stop("Test finished."); }
  const busy = setup({ next: () => ({ done: true, reason: "Fixture complete." }) }, { shouldWait: () => true });
  try {
    busy.session.tick(600); assert.equal(busy.emulator.frameNumber, 600); assert.equal(busy.counts().decisions, 0);
    busy.session.tick(1); await busy.session.waitForPending(); assert.equal(busy.counts().decisions, 1);
  } finally { busy.session.stop("Test finished."); }
});

test("a never-ending executor stops at its frame ceiling and pause cancels the current target", async () => {
  const ceiling = setup({ next: () => ({ done: false, buttons: ["UP"] }) }, { frames: 600 });
  try {
    await runAgentHeadless(ceiling.emulator, ceiling.session, new AbortController().signal);
    assert.equal(ceiling.emulator.frameNumber, 604);
    assert.match(String(ceiling.records.find(record => record.type === "action")!.executionReason), /frame ceiling/);
    assert.equal(ceiling.counts().decisions, 1);
  } finally { ceiling.session.stop("Test finished."); }
  const reasons: string[] = [];
  const paused = setup({ next: () => ({ done: false, buttons: ["LEFT"] }), finish: reason => reasons.push(reason) });
  try {
    paused.session.tick(1); await paused.session.waitForPending(); paused.session.tick(5);
    paused.session.pause(); paused.session.tick(100);
    assert.equal(paused.emulator.frameNumber, 5); assert.deepEqual(reasons, ["Profile action cancelled."]);
    assert.equal(paused.records.find(record => record.type === "action")!.interrupted, true);
  } finally { paused.session.stop("Test finished."); }
});

test("missing executors and invalid controller steps fail before sending any input", async () => {
  for (const missingExecutor of [true, false]) {
    const fixture = setup({ next: () => ({ done: false, buttons: ["UP", "DOWN"] }) }, { missingExecutor });
    try {
      await runAgentHeadless(fixture.emulator, fixture.session, new AbortController().signal);
      assert.equal(fixture.session.snapshot.state, "error"); assert.equal(fixture.emulator.inputs.length, 0);
    } finally { fixture.session.stop("Test finished."); }
  }
  assert.throws(() => validateAgentActions([{ ...target, buttons: ["A"] }], GAME_BOY_DESCRIPTOR.buttons), /Profile actions/);
  assert.throws(() => validateAgentActions([{ ...target, frames: 601 }], GAME_BOY_DESCRIPTOR.buttons), /frames/);
});

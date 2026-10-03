import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentAction, Decision, DecisionContext, GameState, VisualObservation } from "../src/core/agent.js";
import type { EmulatorAction } from "../src/core/emulator.js";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { createStateObserver } from "../src/observation/state.js";
import { withVision } from "../src/observation/combined.js";
import { DemoGameReader } from "../src/profiles/demo.js";
import { bindGameReader } from "../src/profiles/registry.js";
import { AgentFailure, RequestBudget } from "../src/providers/requests.js";
import { AgentSession } from "../src/runner/agent-session.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}
const objectives = { goal: "Inspect continuous gameplay", constraints: [], milestones: [] };
const budget = () => new RequestBudget({ maxRequests: 10, timeoutMs: 1000, intervalMs: 0, retries: 0 });
const decision = (actionId: string): Decision => ({ actionId, confidence: null, probabilities: {}, model: "fixture", usage: { inputTokens: 0, outputTokens: 0 } });

class TrackingEmulator extends GameBoyEmulator {
  readonly inputs: EmulatorAction[] = [];
  override advance(action: EmulatorAction): void { this.inputs.push(structuredClone(action)); super.advance(action); }
}

test("continuous ticks advance through vision and Jev, retain one snapshot, and never extend the selected button hold", async () => {
  const emulator = new TrackingEmulator(createDemoRom());
  emulator.advance({ buttons: [], frames: 12 }); emulator.inputs.length = 0;
  const readFrames: number[] = [];
  class Reader extends DemoGameReader {
    override availableActions(state: GameState, actions: readonly AgentAction[]) {
      readFrames.push(state.frame); return super.availableActions(state, actions);
    }
  }
  const visual = deferred<VisualObservation>(), chosen = deferred<Decision>();
  const visionStarted = deferred<void>(), decisionStarted = deferred<void>();
  let visionCalls = 0, decisionCalls = 0;
  let context: DecisionContext | undefined;
  const records: unknown[] = [];
  const session = new AgentSession(emulator, { mode: "mock", visionProvider: "mock", objectives, budget: budget(),
    actionFrames: 8, maxDecisions: 1, maxSeconds: 60, record: (event) => records.push(event),
    observer: withVision(createStateObserver(bindGameReader(new Reader(), emulator, 8)), { observe(frame) {
      assert.equal(frame.number, 12); visionCalls++; visionStarted.resolve(); return visual.promise;
    } }),
    decider: { decide(value) { context = value; decisionCalls++; decisionStarted.resolve(); return chosen.promise; } },
  });
  try {
    session.tick(2, true); await visionStarted.promise;
    session.tick(4, true);
    assert.equal(session.snapshot.state, "observing"); assert.equal(session.advancing, true);
    assert.equal(emulator.frameNumber, 18); assert.equal(visionCalls, 1); assert.equal(decisionCalls, 0);
    visual.resolve({ text: "Scrolling checkerboard", model: "fixture-vision", usage: { inputTokens: 0, outputTokens: 0 } });
    await decisionStarted.promise;
    assert.equal(context!.frame, 12); assert.equal(context!.gameState!.frame, 12);
    session.tick(20, true);
    assert.equal(session.snapshot.state, "thinking"); assert.equal(session.advancing, true);
    assert.equal(emulator.frameNumber, 38); assert.equal(decisionCalls, 1);
    assert.ok(emulator.inputs.every((action) => action.buttons.length === 0));
    chosen.resolve(decision("press_right")); await session.waitForPending();
    assert.deepEqual(readFrames, [12, 38]);
    session.tick(10, true); session.tick(100, true);
    assert.equal(emulator.frameNumber, 50); assert.equal(session.snapshot.state, "stopped");
    assert.equal(visionCalls, 1); assert.equal(decisionCalls, 1);
    assert.deepEqual(emulator.inputs.filter((action) => action.buttons.length), [{ buttons: ["RIGHT"], frames: 8 }]);
    assert.deepEqual(records.filter((event) => (event as { type: string }).type === "action").map((event) => {
      const action = event as { fromFrame: number; toFrame: number }; return [action.fromFrame, action.toFrame];
    }), [[38, 50]]);
    const stoppedFrame = emulator.frameNumber;
    session.tick(10, true); assert.equal(emulator.frameNumber, stoppedFrame);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("obsolete reader actions are discarded without pausing or substituting inputs, and the next request gets fresh state", async () => {
  const emulator = new TrackingEmulator(createDemoRom());
  emulator.advance({ buttons: [], frames: 12 }); emulator.inputs.length = 0;
  class Reader extends DemoGameReader {
    override availableActions(state: GameState, actions: readonly AgentAction[]) {
      return super.availableActions(state, actions).filter((action) => state.frame < 16 || action.id !== "press_right");
    }
  }
  const chosen = deferred<Decision>(), started = deferred<void>();
  const contexts: DecisionContext[] = [];
  const records: unknown[] = [];
  const session = new AgentSession(emulator, { mode: "mock", visionProvider: "none", objectives, budget: budget(),
    observer: createStateObserver(bindGameReader(new Reader(), emulator, 8)), actionFrames: 8, maxDecisions: 2, maxSeconds: 60,
    record: (event) => records.push(event), decider: { async decide(context) {
      contexts.push(context); started.resolve(); return contexts.length === 1 ? chosen.promise : decision("wait");
    } },
  });
  try {
    session.tick(2, true); await started.promise; session.tick(8, true);
    chosen.resolve(decision("press_right")); await session.waitForPending();
    assert.equal(session.snapshot.state, "idle"); assert.equal(session.advancing, true); assert.equal(session.snapshot.decisions, 1);
    assert.equal(session.inspection.exchange!.status, "complete");
    assert.match(session.inspection.exchange!.warnings[0]!, /no longer available/);
    assert.equal(records.filter((event) => (event as { type: string }).type === "decision-discarded").length, 1);
    session.tick(3, true); await session.waitForPending();
    assert.equal(contexts[1]!.frame, 22); assert.equal(contexts[1]!.gameState!.frame, 22);
    assert.ok(contexts[0]!.actions.some((action) => action.id === "press_right"));
    assert.ok(contexts[1]!.actions.every((action) => action.id !== "press_right"));
    assert.equal(contexts[1]!.history.length, 0);
    session.tick(20, true);
    assert.equal(session.snapshot.decisions, 2); assert.match(session.snapshot.stopReason!, /Decision limit/);
    assert.ok(emulator.inputs.every((action) => action.buttons.length === 0));
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("a stable action ID cannot replace the inputs or duration Jev was offered", async () => {
  for (const change of ["buttons", "frames"] as const) {
    const emulator = new TrackingEmulator(createDemoRom());
    emulator.advance({ buttons: [], frames: 12 }); emulator.inputs.length = 0;
    class Reader extends DemoGameReader {
      override availableActions(state: GameState, actions: readonly AgentAction[]) {
        return super.availableActions(state, actions).map((action) => state.frame >= 16 && action.id === "press_right" ?
          { ...action, ...(change === "buttons" ? { buttons: ["LEFT"] } : { frames: 4 }) } : action);
      }
    }
    const chosen = deferred<Decision>(), started = deferred<void>();
    const session = new AgentSession(emulator, { mode: "mock", objectives, budget: budget(), actionFrames: 8, maxDecisions: 3, maxSeconds: 60,
      observer: createStateObserver(bindGameReader(new Reader(), emulator, 8)),
      decider: { decide() { started.resolve(); return chosen.promise; } },
    });
    try {
      session.tick(8, true); await started.promise;
      chosen.resolve(decision("press_right")); await session.waitForPending();
      assert.equal(session.snapshot.state, "idle"); assert.ok(emulator.inputs.every((action) => action.buttons.length === 0));
      assert.match(session.inspection.exchange!.warnings[0]!, /no longer available/);
    } finally { session.stop("Test finished."); emulator.dispose(); }
  }
});

test("continuous gameplay stops on explicit pause or provider failure and discards late responses", async () => {
  for (const outcome of ["pause", "error"] as const) {
    const emulator = new TrackingEmulator(createDemoRom());
    const chosen = deferred<Decision>(), started = deferred<void>();
    const session = new AgentSession(emulator, { mode: "mock", objectives, budget: budget(), actionFrames: 8, maxDecisions: 3, maxSeconds: 60,
      observer: createStateObserver(bindGameReader(new DemoGameReader(), emulator, 8)),
      decider: { decide() { started.resolve(); return chosen.promise; } },
    });
    try {
      session.tick(2, true); await started.promise; session.tick(20, true);
      const frame = emulator.frameNumber;
      if (outcome === "pause") { session.pause(); chosen.resolve(decision("wait")); }
      else chosen.reject(new AgentFailure("Fixture provider failed."));
      await session.waitForPending(); session.tick(20, true);
      assert.equal(emulator.frameNumber, frame); assert.equal(session.advancing, false);
      assert.equal(session.snapshot.state, outcome === "pause" ? "paused" : "error"); assert.equal(session.snapshot.decisions, 0);
      assert.ok(emulator.inputs.every((action) => action.buttons.length === 0));
    } finally { session.stop("Test finished."); emulator.dispose(); }
  }
});

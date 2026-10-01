import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Decision, DecisionContext, DecisionProvider } from "../src/core/agent.js";
import { parseCliOptions } from "../src/config/cli-options.js";
import { parseObjectives } from "../src/config/objectives.js";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { createMockProviders } from "./fixtures/agent-providers.js";
import { RequestBudget } from "../src/providers/requests.js";
import { runAgentHeadless } from "../src/runner/agent-headless.js";
import { AgentSession } from "../src/runner/agent-session.js";

const objectives = parseObjectives({ goal: "Inspect the controls", constraints: ["Keep the session bounded"] });
const budget = () => new RequestBudget({ maxRequests: 20, timeoutMs: 1000, intervalMs: 0, retries: 0 });
function createSession(emulator: GameBoyEmulator, decider?: DecisionProvider, maxDecisions = 3, record?: (event: unknown) => void) {
  return new AgentSession(emulator, { ...createMockProviders(), ...(decider ? { decider } : {}),
    mode: "mock", objectives, budget: budget(), actionFrames: 24, maxDecisions, maxSeconds: 60,
    ...(record ? { record } : {}),
  });
}
function decision(actionId: string): Decision {
  return { actionId, model: "test-jev", confidence: 0.7, probabilities: {}, usage: { inputTokens: 2, outputTokens: 1 } };
}

test("agent CLI requires objectives, rejects conflicting inputs, and validates objective files", () => {
  const options = parseCliOptions(["--demo", "--agent", "mock", "--goal", "Test", "--headless", "--decisions", "3"]);
  assert.equal(options.frames, 1_000_000);
  assert.equal(options.decisions, 3);
  for (const suffix of [["--agent", "unknown"], ["--agent", "mock"], ["--goal", "Test"],
    ["--agent", "mock", "--goal", "Test", "--objectives", "goals.json"],
    ["--agent", "mock", "--goal", "Test", "--headless", "--buttons", "A"], ["--decisions", "5"]]) {
    assert.throws(() => parseCliOptions(["--demo", ...suffix]));
  }
  for (const value of [{ goal: " " }, { goal: "Test", constraints: [5] }, { goal: "Test", milestones: new Array(17).fill("X") }]) {
    assert.throws(() => parseObjectives(value));
  }
});

test("mock gameplay applies bounded actions and releases, writes records, and stops at the decision limit", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const events: unknown[] = [];
  const session = createSession(emulator, undefined, 3, (event) => events.push(event));
  try {
    await runAgentHeadless(emulator, session, new AbortController().signal);
    assert.equal(emulator.frameNumber, 84);
    assert.equal(session.snapshot.decisions, 3);
    assert.equal(session.snapshot.requests, 0);
    assert.equal(session.snapshot.state, "stopped");
    assert.match(session.snapshot.stopReason!, /Decision limit/);
    assert.equal(session.snapshot.completion, "unverified");
    assert.equal(events.filter((event) => (event as { type: string }).type === "decision").length, 3);
    const control = new GameBoyEmulator(createDemoRom());
    try {
      for (const button of ["RIGHT", "DOWN", "LEFT"]) {
        control.advance({ buttons: [button], frames: 24 }); control.advance({ buttons: [], frames: 4 });
      }
      assert.deepEqual(emulator.captureFrame().pixels, control.captureFrame().pixels);
    } finally { control.dispose(); }
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("unknown model-selected actions never reach the emulator", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const session = createSession(emulator, { async decide() { return decision("inject_unlisted_input"); } });
  try {
    session.tick(3); await session.waitForPending();
    assert.equal(emulator.frameNumber, 0);
    assert.equal(session.snapshot.state, "error");
    assert.match(session.snapshot.stopReason!, /outside the supplied/);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("pause discards pending decisions and restoring clears history without resetting budgets", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  let resolve!: (value: Decision) => void;
  let calls = 0;
  const contexts: DecisionContext[] = [];
  const session = createSession(emulator, { decide(context) {
    calls++; contexts.push(context); return new Promise<Decision>((complete) => { resolve = complete; });
  } });
  try {
    session.tick(2); await Promise.resolve();
    assert.equal(calls, 1);
    session.tick(2); assert.equal(calls, 1);
    session.pause(); resolve(decision("press_right")); await session.waitForPending();
    assert.equal(session.snapshot.decisions, 0);
    assert.equal(session.snapshot.state, "paused"); assert.equal(emulator.frameNumber, 0);
    session.resume(); session.tick(2); await Promise.resolve();
    resolve(decision("press_right")); await session.waitForPending(); session.tick(28);
    assert.equal(session.snapshot.decisions, 1); assert.equal(emulator.frameNumber, 28);
    emulator.reset(); session.clearHistory(); session.resume(); session.tick(1); await Promise.resolve();
    assert.equal(contexts.at(-1)!.history.length, 0); assert.equal(contexts.at(-1)!.frame, 0);
    assert.equal(session.snapshot.decisions, 1);
    resolve(decision("wait")); await session.waitForPending();
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("recent history stays bounded, reports repeated screens, and headless frames cannot overrun", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const contexts: DecisionContext[] = [];
  const session = createSession(emulator, { async decide(context) { contexts.push(context); return decision("wait"); } }, 16);
  try {
    await runAgentHeadless(emulator, session, new AbortController().signal, 360);
    assert.equal(emulator.frameNumber, 360);
    assert.equal(contexts.at(-1)!.history.length, 12);
    assert.ok(contexts.at(-1)!.unchangedScreens > 0);
    assert.match(session.snapshot.stopReason!, /frame limit/);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("both perception and decisions share attempts; retries, cancellation, and failures remain bounded", async () => {
  const shared = new RequestBudget({ maxRequests: 3, timeoutMs: 1000, intervalMs: 0, retries: 1 });
  const signal = new AbortController().signal;
  let tries = 0;
  await shared.run("Vision", signal, async () => {
    if (++tries === 1) throw { statusCode: 429, message: "private token: NEVER_LOG_THIS" };
    return "visible menu";
  });
  await shared.run("Jev", signal, async () => "press_start");
  assert.equal(shared.requests, 3);
  await assert.rejects(shared.run("Vision", signal, async () => "unused"), /request limit/);
  const failed = budget();
  await assert.rejects(failed.run("Jev", signal, async () => { throw { statusCode: 401, message: "NEVER_LOG_THIS" }; }), (error: Error) => {
    assert.match(error.message, /authentication/); assert.doesNotMatch(error.message, /NEVER_LOG_THIS/); return true;
  });
  const controller = new AbortController();
  const pending = failed.run("Vision", controller.signal, async () => new Promise(() => {}));
  controller.abort(); await assert.rejects(pending);
});

test("Jev stop and interruption do not claim objective completion", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const session = createSession(emulator, { async decide() { return decision("stop"); } });
  try {
    await runAgentHeadless(emulator, session, new AbortController().signal);
    assert.equal(emulator.frameNumber, 0); assert.match(session.snapshot.stopReason!, /completion is unverified/);
    assert.throws(() => session.resume(), /has ended/);
    const interrupted = createSession(emulator);
    const controller = new AbortController(); controller.abort();
    await runAgentHeadless(emulator, interrupted, controller.signal);
    assert.equal(interrupted.snapshot.decisions, 0);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("request timeouts abort model work and the wall-clock limit includes paused time", async () => {
  const timed = new RequestBudget({ maxRequests: 3, timeoutMs: 20, intervalMs: 0, retries: 0 });
  const timeout = assert.rejects(timed.run("Vision", new AbortController().signal, async () => new Promise(() => {})), /timed out/);
  await Promise.all([timeout, delay(30)]);
  assert.equal(timed.requests, 1);
  const emulator = new GameBoyEmulator(createDemoRom());
  const session = new AgentSession(emulator, { ...createMockProviders(), mode: "mock", objectives,
    budget: timed, actionFrames: 24, maxDecisions: 10, maxSeconds: 1,
  });
  // Pause also counts against the wall-clock deadline, without issuing requests.
  try {
    session.pause(); await delay(1010);
    assert.equal(session.snapshot.state, "stopped"); assert.match(session.snapshot.stopReason!, /time limit/);
    assert.equal(session.snapshot.requests, 1);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

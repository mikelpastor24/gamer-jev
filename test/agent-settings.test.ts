import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentSettings, Decision, DecisionContext, DecisionProvider } from "../src/core/agent.js";
import { parseAgentSettings } from "../src/config/agent-settings.js";
import { parseCliOptions } from "../src/config/cli-options.js";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { createStateObserver } from "../src/observation/state.js";
import { withVision } from "../src/observation/combined.js";
import { bindGameReader } from "../src/profiles/registry.js";
import { DemoGameReader } from "../src/profiles/demo.js";
import { RequestBudget } from "../src/providers/requests.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { runAgentHeadless } from "../src/runner/agent-headless.js";
import { startViewer } from "../src/server/viewer.js";

const objectives = { goal: "Inspect the fixture", constraints: ["Stay near the starting point"], milestones: [] };
const settings: AgentSettings = { objectives, maxDecisions: 3, maxRequests: 10, maxSeconds: 60, actionFrames: 8 };
const decision = (actionId = "wait"): Decision => ({ actionId, confidence: 1, probabilities: {}, model: "fixture", usage: { inputTokens: 0, outputTokens: 0 } });
const budget = (maximum: number | null = 10) => new RequestBudget({ maxRequests: maximum, timeoutMs: 1000, intervalMs: 0, retries: 0 });
function createSession(emulator: GameBoyEmulator, decider: DecisionProvider, configuration: AgentSettings = settings) {
  return new AgentSession(emulator, { mode: "mock", visionProvider: "none", objectives: configuration.objectives,
    observer: createStateObserver(bindGameReader(new DemoGameReader(), emulator, configuration.actionFrames)),
    decider, budget: budget(configuration.maxRequests), actionFrames: configuration.actionFrames,
    maxDecisions: configuration.maxDecisions, maxSeconds: configuration.maxSeconds });
}

test("agent settings accept explicit unlimited ceilings while rejecting invalid objectives and unbounded actions", () => {
  assert.equal(parseAgentSettings({ ...settings, maxSeconds: null }).maxSeconds, null);
  for (const value of [{ ...settings, maxDecisions: 0 }, { ...settings, maxRequests: Infinity },
    { ...settings, maxSeconds: 86_401 }, { ...settings, actionFrames: null }, { ...settings, actionFrames: 601 },
    { ...settings, objectives: { goal: " " } }, { ...settings, credentials: "unexpected" }, { ...settings, maxDecisions: "unlimited" }]) {
    assert.throws(() => parseAgentSettings(value));
  }
  const unlimited = parseCliOptions(["--demo", "--agent", "mock", "--goal", "Explore", "--headless", "--unlimited"]);
  assert.equal(unlimited.decisions, null); assert.equal(unlimited.requests, null);
  assert.equal(unlimited.maxSeconds, null); assert.equal(unlimited.frames, null);
  assert.equal(parseCliOptions(["--demo", "--agent", "mock", "--goal", "Explore", "--headless", "--unlimited", "--frames", "8"]).frames, 8);
  assert.equal(parseCliOptions(["--demo", "--agent", "mock", "--goal", "Explore", "--decisions", "unlimited"]).decisions, null);
  for (const args of [["--demo", "--unlimited"], ["--demo", "--headless", "--frames", "unlimited"],
    ["--demo", "--agent", "mock", "--goal", "Explore", "--unlimited", "--requests", "10"]]) {
    assert.throws(() => parseCliOptions(args));
  }
});

test("unlimited headless sessions keep bounded actions and history, honor Jev stop, and still reject invalid actions", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const contexts: DecisionContext[] = [];
  const unlimited = { ...settings, maxDecisions: null, maxRequests: null, maxSeconds: null };
  const session = createSession(emulator, { async decide(context) {
    contexts.push(context); return decision(contexts.length === 18 ? "stop" : "wait");
  } }, unlimited);
  try {
    await runAgentHeadless(emulator, session, new AbortController().signal, null);
    assert.equal(session.snapshot.decisions, 18); assert.equal(emulator.frameNumber, 17 * 8);
    assert.equal(contexts.at(-1)!.history.length, 12);
    assert.match(session.snapshot.stopReason!, /completion is unverified/);
    const invalid = createSession(emulator, { async decide() { return decision("unlisted"); } }, unlimited);
    await runAgentHeadless(emulator, invalid, new AbortController().signal, null);
    assert.equal(invalid.snapshot.state, "error"); assert.equal(emulator.frameNumber, 17 * 8);
    const interrupted = createSession(emulator, { async decide() { return decision(); } }, unlimited);
    const controller = new AbortController(); controller.abort();
    await runAgentHeadless(emulator, interrupted, controller.signal, null);
    assert.match(interrupted.snapshot.stopReason!, /interrupted/);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("editing an in-flight decision cancels old context, preserves counters, and applies objectives and reader action duration on resume", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  let finish: (result: Decision) => void = () => {};
  const contexts: DecisionContext[] = [];
  const signals: AbortSignal[] = [];
  const session = createSession(emulator, { decide(context, signal) {
    contexts.push(context); signals.push(signal);
    if (contexts.length === 1) return new Promise((resolve) => { finish = resolve; });
    return Promise.resolve(decision());
  } });
  try {
    session.tick(1); await Promise.resolve();
    const current = session.inspection.exchange!;
    assert.equal(current.status, "pending");
    session.updateSettings({ ...settings, objectives: { goal: "Explore the new area", constraints: ["Avoid battles"], milestones: ["Find the exit"] }, actionFrames: 4 }, 0);
    assert.equal(signals[0]!.aborted, true); assert.equal(session.snapshot.state, "paused");
    finish(decision()); await session.waitForPending();
    assert.equal(session.snapshot.decisions, 0); assert.equal(emulator.frameNumber, 0);
    assert.equal(session.inspection.exchange!.status, "cancelled");
    assert.equal(current.request.state && (current.request.state as DecisionContext).objectives.goal, objectives.goal);
    session.resume(); session.tick(1); await session.waitForPending(); session.tick(4);
    assert.deepEqual(contexts[1]!.objectives, { goal: "Explore the new area", constraints: ["Avoid battles"], milestones: ["Find the exit"] });
    assert.equal(contexts[1]!.actions.find((action) => action.id === "wait")!.frames, 4);
    assert.equal(emulator.frameNumber, 4); assert.equal(session.snapshot.decisions, 1);
    const before = session.configuration;
    assert.throws(() => session.updateSettings({ ...settings, objectives: { goal: " " } }, 1));
    assert.deepEqual(session.configuration, before); assert.equal(session.snapshot.state, "idle");
    assert.throws(() => session.updateSettings(settings, 0), /another window/);
    assert.deepEqual(session.configuration, before);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("pending vision is invalidated by an objective edit and counted attempts remain in the shared budget", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const shared = budget();
  const visionGoals: string[] = [];
  let started: () => void = () => {};
  const pending = new Promise<void>((resolve) => { started = resolve; });
  const session = new AgentSession(emulator, { mode: "mock", visionProvider: "mock", objectives,
    observer: withVision(createStateObserver(bindGameReader(new DemoGameReader(), emulator, 8)), { async observe(_frame, _previous, goals, signal) {
      visionGoals.push(goals.goal);
      await shared.run("Vision", signal, async () => { if (visionGoals.length === 1) { started(); return new Promise(() => {}); } return true; });
      return { text: "Invented fixture evidence", model: "fixture", usage: { inputTokens: 0, outputTokens: 0 } };
    } }), decider: { async decide() { return decision(); } }, budget: shared,
    actionFrames: 8, maxDecisions: 3, maxSeconds: 60,
  });
  try {
    session.tick(1); await pending;
    session.updateSettings({ ...settings, objectives: { ...objectives, goal: "Find the exit" } }, 0);
    await session.waitForPending();
    assert.equal(shared.requests, 1); assert.equal(session.snapshot.decisions, 0);
    session.resume(); session.tick(1); await session.waitForPending();
    assert.deepEqual(visionGoals, [objectives.goal, "Find the exit"]);
    assert.equal(shared.requests, 2); assert.equal(session.snapshot.decisions, 1);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("a stopped session can extend or disable ceilings without resetting elapsed time, frame state, or counters", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const session = createSession(emulator, { async decide() { return decision(); } }, { ...settings, maxDecisions: 1 });
  try {
    session.tick(1); await session.waitForPending(); session.tick(8);
    assert.equal(session.terminal, true); assert.equal(session.snapshot.decisions, 1);
    session.updateSettings({ ...settings, maxDecisions: 2 }, 0);
    assert.equal(session.snapshot.state, "paused"); assert.equal(emulator.frameNumber, 8);
    session.resume(); session.tick(1); await session.waitForPending(); session.tick(8);
    assert.equal(session.snapshot.decisions, 2); assert.equal(session.terminal, true);
    session.updateSettings({ ...settings, maxDecisions: null, maxRequests: null, maxSeconds: null }, 1);
    assert.equal(session.snapshot.state, "paused"); session.resume();
    session.tick(1); await session.waitForPending(); session.tick(8);
    assert.equal(session.snapshot.decisions, 3); assert.equal(session.terminal, false);
    session.updateSettings({ ...settings, maxDecisions: 2 }, 2);
    assert.equal(session.terminal, true); assert.match(session.snapshot.stopReason!, /Decision limit/);
  } finally { session.stop("Test finished."); emulator.dispose(); }
  const timed = new GameBoyEmulator(createDemoRom());
  const timerSession = createSession(timed, { async decide() { return decision(); } }, { ...settings, maxSeconds: 1 });
  try {
    timerSession.updateSettings({ ...settings, maxSeconds: null }, 0);
    await delay(1100);
    assert.equal(timerSession.snapshot.state, "paused"); assert.ok(timerSession.snapshot.elapsedSeconds >= 1);
    timerSession.updateSettings({ ...settings, maxSeconds: 1 }, 1);
    assert.equal(timerSession.terminal, true); assert.match(timerSession.snapshot.stopReason!, /time limit/);
    timerSession.updateSettings({ ...settings, maxSeconds: 60 }, 2);
    assert.equal(timerSession.snapshot.state, "paused"); assert.ok(timerSession.snapshot.elapsedSeconds >= 1);
  } finally { timerSession.stop("Test finished."); timed.dispose(); }
});

test("request ceilings can change while preserving attempts, throttling, request timeouts, and retry bounds", async () => {
  const shared = budget(1);
  const signal = new AbortController().signal;
  await shared.run("Jev", signal, async () => true);
  await assert.rejects(shared.run("Jev", signal, async () => true), /request limit/);
  shared.setMaxRequests(null);
  await shared.run("Vision", signal, async () => true);
  assert.equal(shared.requests, 2); assert.equal(shared.limits.timeoutMs, 1000); assert.equal(shared.limits.retries, 0);
  shared.setMaxRequests(1);
  await assert.rejects(shared.run("Jev", signal, async () => true), /request limit/);
  assert.equal(shared.requests, 2); assert.throws(() => shared.setMaxRequests(0));
  const waiting = new RequestBudget({ maxRequests: null, timeoutMs: 1000, intervalMs: 30, retries: 0 });
  await waiting.run("Jev", signal, async () => true);
  const second = waiting.run("Jev", signal, async () => { throw new Error("Must not send a request after reducing its ceiling"); });
  waiting.setMaxRequests(1);
  await assert.rejects(second, /request limit/); assert.equal(waiting.requests, 1);
});

test("the local settings API validates complete edits and revisions, preserves emulator state, accepts long objectives, and rejects foreign requests", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const agent = createSession(emulator, { async decide() { return decision(); } });
  const viewer = await startViewer(emulator, { agent, port: 0, speed: 1, paused: true, checkpointPath: "unused-checkpoint.json" });
  const post = (data: unknown, origin = viewer.url) => fetch(`${viewer.url}/api/agent-settings`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(data),
  });
  try {
    const initial = await (await fetch(`${viewer.url}/api/agent-settings`)).json();
    assert.equal(initial.revision, 0); assert.deepEqual(initial.settings, settings);
    assert.equal((await fetch(`${viewer.url}/agent-settings.js`)).status, 200);
    assert.equal((await post({ revision: 0, settings: { ...settings, maxSeconds: 0 } })).status, 400);
    assert.equal((await post({ revision: 0, settings }, "https://example.com")).status, 403);
    assert.deepEqual(agent.configuration, initial); assert.equal(emulator.frameNumber, 0);
    const long = { ...settings, objectives: { goal: "G".repeat(2000), constraints: Array(16).fill("C".repeat(500)), milestones: Array(16).fill("M".repeat(500)) } };
    const response = await post({ revision: 0, settings: long });
    assert.equal(response.status, 200); assert.equal((await response.json()).agent.settingsRevision, 1);
    assert.equal(agent.snapshot.state, "paused"); assert.equal(agent.snapshot.goal.length, 2000);
    assert.equal((await post({ revision: 0, settings })).status, 400);
    assert.equal((await post({ revision: 1, settings: { ...long, objectives: { goal: "G".repeat(40_000) } } })).status, 400);
    assert.equal(agent.configuration.revision, 1); assert.equal(emulator.frameNumber, 0);
  } finally { await viewer.close(); emulator.dispose(); }
});

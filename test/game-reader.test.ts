import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { GameReader } from "../src/core/game-reader.js";
import type { DecisionContext } from "../src/core/agent.js";
import { controllerActions, validateAgentActions } from "../src/core/actions.js";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { DemoGameReader } from "../src/profiles/demo.js";
import { GameReaderRegistry, bindGameReader } from "../src/profiles/registry.js";
import { loadJsonGameReader, parseJsonGameReader } from "../src/profiles/json.js";
import { createStateObserver } from "../src/observation/state.js";
import { withVision } from "../src/observation/combined.js";
import { createGatewayDecisionProvider } from "../src/jev/gateway.js";
import { createMockVisionProvider } from "../src/vision/mock.js";
import { RequestBudget } from "../src/providers/requests.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { runAgentHeadless } from "../src/runner/agent-headless.js";
import { parseCliOptions } from "../src/config/cli-options.js";
import { validateGameState } from "../src/core/game-state.js";

const objectives = { goal: "Increase the horizontal scroll offset", constraints: [], milestones: [] };
const budget = () => new RequestBudget({ maxRequests: 8, timeoutMs: 1000, intervalMs: 0, retries: 0 });
const decision = (actionId: string) => ({ actionId, model: "test-jev", confidence: null, probabilities: {}, usage: { inputTokens: 0, outputTokens: 0 } });

test("optional action context keys are bounded and validated before use", () => {
  const action = controllerActions(["A"], 8)[0]!;
  validateAgentActions([action, { ...action, id: "other", availabilityKey: "a".repeat(128) }], ["A"]);
  for (const availabilityKey of ["", " ", "a".repeat(129), 123, null]) {
    assert.throws(() => validateAgentActions([{ ...action, availabilityKey } as typeof action], ["A"]), /availability key/);
  }
});

test("profile-owned decision support is bounded, copied, and preserved through optional vision", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const facts = ["The fixture scroll offset can increase."];
  const reader: GameReader = { descriptor: new DemoGameReader().descriptor,
    readState(memory) {
      assert.equal(memory.readRom!(0x134, 1)[0], 71);
      return { values: { phase: "running" }, descriptions: {},
        decisionSupport: { facts, actionFacts: { press_right: ["Increase the offset."], press_left: ["Decrease it."] } } };
    },
    availableActions(_state, actions) { return actions.filter(action => ["press_right", "wait", "stop"].includes(action.id)); },
  };
  try {
    const provider = bindGameReader(reader, emulator, 8);
    const snapshot = provider.read(emulator.captureFrame());
    assert.deepEqual(Object.keys(snapshot.state.decisionSupport!.actionFacts), ["press_right"]);
    (snapshot.state.decisionSupport!.facts as string[])[0] = "Changed in the caller";
    assert.equal(facts[0], "The fixture scroll offset can increase.");
    const observation = await withVision(createStateObserver(provider), createMockVisionProvider()).observe(
      emulator.captureFrame(), undefined, objectives, new AbortController().signal);
    assert.equal(observation.gameState!.decisionSupport!.facts[0], facts[0]);
    const good = provider.read(emulator.captureFrame()).state;
    for (const support of [
      { facts: Array.from({ length: 33 }, () => "Too many"), actionFacts: {} },
      { facts: ["x".repeat(501)], actionFacts: {} },
      { facts: [], actionFacts: { wait: Array.from({ length: 9 }, () => "Too many") } },
      { facts: [], actionFacts: { "invalid id": ["Invalid"] } },
      { facts: [], actionFacts: [] },
    ]) assert.throws(() => validateGameState({ ...good, decisionSupport: support } as unknown as typeof good, 0), /decision support/);
    assert.equal(emulator.frameNumber, 0);
  } finally { emulator.dispose(); }
});

test("reader strategies are selected by console and exact ROM revision, with independent factories", () => {
  const first = new GameBoyEmulator(createDemoRom());
  const bytes = createDemoRom(); bytes[0x134] = 88;
  const second = new GameBoyEmulator(bytes);
  const registry = new GameReaderRegistry();
  const demo = new DemoGameReader();
  let instances = 0;
  registry.register({ descriptor: demo.descriptor, create: () => { instances++; return new DemoGameReader(); } });
  const descriptor = { id: "other-game", name: "Independent reader fixture", consoleId: "game-boy", romSha256: [second.rom.sha256] };
  registry.register({ descriptor, create: (): GameReader => ({ descriptor,
    readState(memory) { return { values: { offset: memory.readMemory(0xff43, 1)[0]! }, descriptions: { offset: "Fixture offset" } }; },
    availableActions(_state, actions) { return actions.filter((action) => action.id === "press_left" || action.id === "wait" || action.stop); },
  }) });
  try {
    assert.equal(registry.createFor(first, 24)!.id, "demo");
    assert.equal(registry.createFor(first, 24)!.id, "demo"); assert.equal(instances, 2);
    assert.equal(registry.createFor(second, 24)!.id, "other-game");
    assert.throws(() => registry.createFor(second, 24, "demo"), /incompatible/);
    assert.throws(() => registry.register({ descriptor: demo.descriptor, create: () => demo }), /already registered/);
    const listed = registry.list(); (listed[0] as { id: string }).id = "changed";
    assert.equal(registry.list()[0]!.id, "demo");
  } finally { first.dispose(); second.dispose(); }
});

test("the real demo reader observes memory changes, filters inputs during initialization, and follows restore", () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const provider = bindGameReader(new DemoGameReader(), emulator, 4);
  try {
    const initial = provider.read(emulator.captureFrame());
    assert.equal(initial.state.values.phase, "initializing");
    assert.deepEqual(initial.actions.map((action) => action.id), ["wait", "stop"]);
    emulator.advance({ buttons: [], frames: 12 });
    const running = provider.read(emulator.captureFrame());
    assert.equal(running.state.values.phase, "running");
    assert.ok(running.actions.some((action) => action.id === "press_right"));
    assert.ok(!running.actions.some((action) => action.id === "press_start"));
    const saved = emulator.saveState();
    emulator.advance({ buttons: ["RIGHT"], frames: 4 });
    const moved = provider.read(emulator.captureFrame());
    assert.notEqual(moved.state.values.scrollX, running.state.values.scrollX);
    emulator.restoreState(saved);
    assert.deepEqual(provider.read(emulator.captureFrame()).state, running.state);
    assert.throws(() => provider.read({ ...emulator.captureFrame(), number: 0 }), /stale/);
  } finally { emulator.dispose(); }
});

test("declarative readers decode byte, signed, endian, flag, and enum fields and filter actions", async () => {
  const file = JSON.parse(await readFile(new URL("../examples/demo-profile.json", import.meta.url), "utf8"));
  file.fields.push(
    { name: "signed", description: "Signed fixture", address: 1, type: "i8" },
    { name: "little", description: "Little endian fixture", address: 2, type: "u16le" },
    { name: "big", description: "Big endian fixture", address: 2, type: "u16be" },
  );
  const reader = parseJsonGameReader(file);
  const state = reader.readState({ readMemory(address, length) {
    const value = address === 1 ? [0xfe] : address === 2 ? [0x34, 0x12] : address === 0xff40 ? [0x80] : address === 0xc000 ? [1] : [5];
    return Uint8Array.from(value.slice(0, length));
  } });
  assert.equal(state.values.signed, -2); assert.equal(state.values.little, 0x1234); assert.equal(state.values.big, 0x3412);
  assert.equal(state.values.lcdEnabled, true); assert.equal(state.values.phase, "running");
  const snapshot = { ...state, source: reader.descriptor.id, frame: 1 };
  assert.equal(reader.availableActions(snapshot, controllerActions(["UP", "DOWN", "LEFT", "RIGHT"], 24)).length, 6);
  assert.deepEqual(reader.availableActions({ ...snapshot, values: { ...snapshot.values, lcdEnabled: false } }, controllerActions(["RIGHT"], 24)).map((action) => action.id), ["wait", "stop"]);
});

test("JSON profile errors and incompatible ROM layouts fail without executing inputs", async () => {
  const file = JSON.parse(await readFile(new URL("../examples/demo-profile.json", import.meta.url), "utf8"));
  for (const edit of [
    (value: typeof file) => { value.fields[0].address = -1; },
    (value: typeof file) => { value.fields[1].name = value.fields[0].name; },
    (value: typeof file) => { value.actions[0].when[0].field = "missing"; },
    (value: typeof file) => { value.romSha256 = ["wrong-hash"]; },
    (value: typeof file) => { value.actions[0].condition = []; },
  ]) {
    const invalid = structuredClone(file); edit(invalid); assert.throws(() => parseJsonGameReader(invalid));
  }
  const emulator = new GameBoyEmulator(createDemoRom());
  try {
    const invalid = structuredClone(file); invalid.fields[0].address = "0x10000";
    const provider = bindGameReader(parseJsonGameReader(invalid), emulator, 24);
    assert.throws(() => provider.read(emulator.captureFrame()), /64 KiB/);
    assert.equal(emulator.frameNumber, 0);
    const wrongConsole = { ...file, consoleId: "another-console" };
    assert.throws(() => bindGameReader(parseJsonGameReader(wrongConsole), emulator, 24), /incompatible/);
  } finally { emulator.dispose(); }
});

test("Jev-only sessions send structured state and current valid choices without vision requests", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const limits = budget(); const bodies: DecisionContext[] = [];
  const decider = createGatewayDecisionProvider({ apiKey: "test-key", model: "typesafe-ai/jev", budget: limits,
    fetch: async (input, init) => {
      assert.equal(String(input), "https://ai-gateway.vercel.sh/v1/evaluate");
      const body = JSON.parse(String(init?.body)); bodies.push(body.state);
      const selected = body.state.gameState.values.phase === "initializing" ? "wait" : "press_right";
      assert.ok(Object.hasOwn(body.questions.next_action.criteria, selected));
      assert.doesNotMatch(String(init?.body), /image_url|data:image/);
      return Response.json({ answers: { next_action: { type: "choice", choice: selected } } });
    },
  });
  const session = new AgentSession(emulator, { mode: "gateway", objectives, decider,
    observer: createStateObserver(bindGameReader(new DemoGameReader(), emulator, 24)), budget: limits,
    actionFrames: 24, maxDecisions: 2, maxSeconds: 60,
  });
  try {
    await runAgentHeadless(emulator, session, new AbortController().signal);
    assert.equal(limits.requests, 2); assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0]!.actions.map((action) => action.id), ["wait", "stop"]);
    assert.ok(bodies[1]!.actions.some((action) => action.id === "press_right"));
    assert.equal(session.snapshot.observationMode, "state");
    assert.equal(emulator.frameNumber, 52);
    assert.ok(emulator.readMemory(0xff43, 1)[0]! > 0);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("vision only adds evidence and cannot replace structured state or available actions", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const state = createStateObserver(bindGameReader(new DemoGameReader(), emulator, 24));
  const observer = withVision(state, { async observe() { return {
    text: "Visible checkerboard", model: "test-vision", usage: { inputTokens: 2, outputTokens: 1 },
    actions: controllerActions(["A"], 24), gameState: { source: "injected", frame: 100, values: {}, descriptions: {} },
  }; } });
  try {
    const snapshot = await observer.observe(emulator.captureFrame(), undefined, objectives, new AbortController().signal);
    assert.equal(snapshot.text, "Visible checkerboard"); assert.equal(snapshot.gameState!.source, "demo");
    assert.deepEqual(snapshot.actions!.map((action) => action.id), ["wait", "stop"]);
    assert.equal(snapshot.usage.inputTokens, 2);
  } finally { emulator.dispose(); }
});

test("Jev cannot select a globally supported button that is unavailable in the current game state", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const session = new AgentSession(emulator, { mode: "mock", objectives, budget: budget(),
    observer: withVision(createStateObserver(bindGameReader(new DemoGameReader(), emulator, 24)), createMockVisionProvider()),
    decider: { async decide() { return decision("press_right"); } }, actionFrames: 24, maxDecisions: 2, maxSeconds: 60,
  });
  try {
    session.tick(1); await session.waitForPending();
    assert.equal(emulator.frameNumber, 0); assert.equal(session.snapshot.state, "error");
    assert.match(session.snapshot.stopReason!, /outside the supplied/);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("CLI keeps provider and observation selection independent and allows manual state inspection", async () => {
  assert.equal(parseCliOptions(["--demo"]).agent, undefined);
  assert.equal(parseCliOptions(["--demo", "--profile", "demo"]).profile, "demo");
  assert.equal(parseCliOptions(["--demo", "--agent", "gateway", "--observation", "state", "--goal", "Test"]).observationMode, "state");
  assert.equal(parseCliOptions(["--demo", "--agent", "gateway", "--goal", "Test"]).observationMode, "vision");
  assert.equal(parseCliOptions(["--list-profiles"]).listProfiles, true);
  assert.throws(() => parseCliOptions(["--demo", "--observation", "state"]), /requires an agent/);
  const reader = await loadJsonGameReader(fileURLToPath(new URL("../examples/demo-profile.json", import.meta.url)));
  assert.equal(reader.descriptor.id, "demo-json");
});

test("reader caches are invalidated through both state-only and combined observation paths", () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  let resets = 0;
  class CachedReader extends DemoGameReader { reset() { resets++; } }
  const state = createStateObserver(bindGameReader(new CachedReader(), emulator, 24));
  const session = new AgentSession(emulator, { mode: "mock", objectives, observer: withVision(state, createMockVisionProvider()),
    decider: { async decide() { return decision("wait"); } }, budget: budget(), actionFrames: 24, maxDecisions: 2, maxSeconds: 60,
  });
  try { state.reset?.(); assert.equal(resets, 1); session.clearHistory(); assert.equal(resets, 2); }
  finally { session.stop("Test finished."); emulator.dispose(); }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionContext, DecisionProviderId, VisionProviderId } from "../src/core/agent.js";
import { parseCliOptions } from "../src/config/cli-options.js";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { createDecisionProvider, createVisionProvider } from "../src/providers/factory.js";
import { RequestBudget } from "../src/providers/requests.js";
import { bindGameReader } from "../src/profiles/registry.js";
import { DemoGameReader } from "../src/profiles/demo.js";
import { createStateObserver } from "../src/observation/state.js";
import { withVision } from "../src/observation/combined.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { runAgentHeadless } from "../src/runner/agent-headless.js";
import { startViewer } from "../src/server/viewer.js";
import { controllerActions } from "../src/core/actions.js";

const objectives = { goal: "Increase scrollX", constraints: [], milestones: [] };
const environment = { TYPESAFE_API_KEY: "private-typesafe-fixture", AI_GATEWAY_API_KEY: "private-gateway-fixture" };
const limits = (retries = 0) => new RequestBudget({ maxRequests: 8, timeoutMs: 1000, intervalMs: 0, retries });

function nativeResult(context: DecisionContext, actionId = "wait") {
  return { model: "jev-1.13.0", answers: { next_action: { type: "choice", choice: actionId,
    probabilities: Object.fromEntries(context.actions.map((action) => [action.id, action.id === actionId ? 1 : 0])), confidence: 0.85 } },
    usage: { input_tokens: 24, output_tokens: 3 } };
}

function initialContext(emulator: GameBoyEmulator): DecisionContext {
  const snapshot = bindGameReader(new DemoGameReader(), emulator, 24).read(emulator.captureFrame());
  return { objectives, console: "game-boy", frame: 0, observation: "Initializing", unchangedScreens: 0, history: [],
    actions: snapshot.actions, gameState: snapshot.state };
}

test("CLI selects Jev and vision independently and preserves legacy observation commands", () => {
  const parse = (agent: string, ...args: string[]) => parseCliOptions(["--demo", "--agent", agent, "--goal", "Test", ...args]);
  for (const agent of ["typesafe", "gateway", "mock"]) for (const vision of ["none", "gateway", "mock"]) {
    const options = parse(agent, "--vision", vision);
    assert.equal(options.agent, agent); assert.equal(options.visionProvider, vision);
    assert.equal(options.observationMode, vision === "none" ? "state" : "vision");
  }
  assert.equal(parse("gateway").visionProvider, "gateway");
  assert.equal(parse("mock").visionProvider, "mock");
  assert.equal(parse("typesafe", "--observation", "state").visionProvider, "none");
  assert.equal(parse("gateway", "--observation", "vision").visionProvider, "gateway");
  assert.equal(parse("mock", "--observation", "vision").visionProvider, "mock");
  assert.equal(parse("typesafe", "--vision", "none", "--observation", "state").visionProvider, "none");
  assert.equal(parseCliOptions(["--demo"]).visionProvider, "none");
  assert.throws(() => parse("invalid"), /--agent must/);
  assert.throws(() => parse("typesafe", "--vision", "invalid"), /--vision must/);
  assert.throws(() => parseCliOptions(["--demo", "--vision", "none"]), /requires an agent/);
  assert.throws(() => parse("typesafe", "--vision", "none", "--observation", "vision"), /conflicts/);
  assert.throws(() => parse("typesafe", "--vision", "gateway", "--observation", "state"), /conflicts/);
});

test("all Jev and vision combinations route credentials separately and share the request budget", async (t) => {
  for (const agent of ["typesafe", "gateway", "mock"] satisfies DecisionProviderId[]) {
    for (const visionId of ["none", "gateway", "mock"] satisfies VisionProviderId[]) {
      await t.test(`${agent} decisions with ${visionId} vision`, async () => {
        const emulator = new GameBoyEmulator(createDemoRom());
        const budget = limits(); const records: unknown[] = [];
        const requests: { url: string; key: string | null; body: Record<string, unknown> }[] = [];
        const settings = { environment, budget, fetch: (async (input, init) => {
          const url = String(input); const body = JSON.parse(String(init?.body));
          requests.push({ url, key: new Headers(init?.headers).get("authorization"), body });
          if (url.endsWith("/chat/completions")) return Response.json({
            choices: [{ message: { content: "A visible checkerboard fills the screen." } }],
            usage: { prompt_tokens: 12, completion_tokens: 8 },
          });
          const context: DecisionContext = body.state;
          const action = context.gameState!.values.phase === "initializing" ? "wait" : "press_right";
          const result = nativeResult(context, action);
          return Response.json(url.endsWith("/systemone") ? result : {
            answers: result.answers, usage: { inputTokens: 24, outputTokens: 3 },
            providerMetadata: { typesafe: { confidence: { next_action: 0.85 } } },
          });
        }) satisfies typeof fetch };
        const decider = createDecisionProvider(agent, settings);
        const vision = createVisionProvider(visionId, settings);
        const state = createStateObserver(bindGameReader(new DemoGameReader(), emulator, 24));
        const session = new AgentSession(emulator, { mode: agent, visionProvider: visionId, objectives, decider,
          observer: vision ? withVision(state, vision) : state, budget, actionFrames: 24, maxDecisions: 2, maxSeconds: 60,
          record: (record) => records.push(record),
        });
        try {
          await runAgentHeadless(emulator, session, new AbortController().signal);
          assert.equal(session.snapshot.state, "stopped"); assert.equal(session.snapshot.decisions, 2);
          assert.equal(session.snapshot.mode, agent); assert.equal(session.snapshot.visionProvider, visionId);
          assert.equal(emulator.frameNumber, 52);
          const expected = 2 * (Number(agent !== "mock") + Number(visionId === "gateway"));
          assert.equal(budget.requests, expected); assert.equal(requests.length, expected);
          const decisions = requests.filter((request) => !request.url.endsWith("/chat/completions"));
          const images = requests.filter((request) => request.url.endsWith("/chat/completions"));
          assert.equal(decisions.length, agent === "mock" ? 0 : 2);
          assert.equal(images.length, visionId === "gateway" ? 2 : 0);
          for (const request of requests) {
            assert.equal(request.key, `Bearer ${request.url.endsWith("/systemone") ? environment.TYPESAFE_API_KEY : environment.AI_GATEWAY_API_KEY}`);
            assert.doesNotMatch(JSON.stringify(request.body), /private-(typesafe|gateway)-fixture/);
          }
          for (const request of decisions) {
            assert.equal(request.url, agent === "typesafe" ? "https://api.typesafe.ai/v1/systemone" : "https://ai-gateway.vercel.sh/v1/evaluate");
            assert.equal(request.body.model, agent === "typesafe" ? "jev-latest" : "typesafe-ai/jev");
            assert.doesNotMatch(JSON.stringify(request.body), /image_url|data:image/);
          }
          for (const request of images) {
            assert.equal(request.body.model, "google/gemini-2.5-flash");
            assert.match(JSON.stringify(request.body), /data:image\/png/);
          }
          if (agent !== "mock") {
            const before = decisions[0]!.body.state as DecisionContext;
            const after = decisions[1]!.body.state as DecisionContext;
            assert.equal(before.gameState!.values.phase, "initializing");
            assert.deepEqual(before.actions.map((action) => action.id), ["wait", "stop"]);
            assert.equal(after.gameState!.values.phase, "running");
            assert.ok(after.actions.some((action) => action.id === "press_right"));
          }
          assert.doesNotMatch(JSON.stringify(records), /private-(typesafe|gateway)-fixture/);
          const metadata = records[0] as { mode: string; visionProvider: string };
          assert.equal(metadata.mode, agent); assert.equal(metadata.visionProvider, visionId);
          if (agent === "typesafe" && visionId === "gateway") {
            const viewer = await startViewer(emulator, { agent: session, port: 0, paused: true, speed: 1, checkpointPath: "unused-checkpoint.json" });
            try {
              const status = await (await fetch(`${viewer.url}/api/status`)).json();
              assert.equal(status.agent.mode, "typesafe"); assert.equal(status.agent.visionProvider, "gateway");
              assert.doesNotMatch(JSON.stringify(status), /private-(typesafe|gateway)-fixture/);
            } finally { await viewer.close(); }
          }
        } finally { session.stop("Test finished."); emulator.dispose(); }
      });
    }
  }
});

test("unselected providers do not require credentials or validate their model settings", () => {
  const direct = { environment: { TYPESAFE_API_KEY: "test-key", AI_GATEWAY_API_KEY: "", JEV_MODEL: "invalid", VISION_MODEL: "invalid" }, budget: limits() };
  assert.doesNotThrow(() => createDecisionProvider("typesafe", direct));
  assert.equal(createVisionProvider("none", direct), undefined);
  assert.doesNotThrow(() => createVisionProvider("mock", direct));
  assert.throws(() => createVisionProvider("gateway", direct), /AI_GATEWAY_API_KEY/);
  const gateway = { environment: { AI_GATEWAY_API_KEY: "test-key", TYPESAFE_MODEL: "invalid", VISION_MODEL: "invalid" }, budget: limits() };
  assert.doesNotThrow(() => createDecisionProvider("gateway", gateway));
  assert.equal(createVisionProvider("none", gateway), undefined);
  assert.throws(() => createDecisionProvider("typesafe", gateway), /TYPESAFE_API_KEY/);
  const offline = { environment: {}, budget: limits() };
  assert.doesNotThrow(() => createDecisionProvider("mock", offline));
  assert.doesNotThrow(() => createVisionProvider("mock", offline));
  assert.throws(() => createDecisionProvider("typesafe", { ...direct, environment: { ...direct.environment, TYPESAFE_MODEL: "typesafe-ai/jev" } }), /TYPESAFE_MODEL/);
  assert.throws(() => createDecisionProvider("typesafe", { ...offline, environment: { TYPESAFE_API_KEY: "replace-with-your-typesafe-api-key" } }), /TYPESAFE_API_KEY/);
});

test("direct TypeSafe maps native confidence, token usage, and the actual response model", async () => {
  const emulator = new GameBoyEmulator(createDemoRom()); const budget = limits();
  const context = initialContext(emulator);
  const provider = createDecisionProvider("typesafe", { environment: { TYPESAFE_API_KEY: "test-key", TYPESAFE_MODEL: "jev-preview" }, budget,
    fetch: async (_input, init) => {
      assert.equal(JSON.parse(String(init?.body)).model, "jev-preview");
      assert.equal(init?.redirect, "error"); assert.ok(init?.signal instanceof AbortSignal);
      return Response.json(nativeResult(context));
    },
  });
  try {
    const decision = await provider.decide(context, new AbortController().signal);
    assert.equal(decision.model, "jev-1.13.0"); assert.equal(decision.confidence, 0.85);
    assert.deepEqual(decision.usage, { inputTokens: 24, outputTokens: 3 });
    assert.deepEqual(decision.probabilities, { wait: 1, stop: 0 }); assert.equal(budget.requests, 1);
  } finally { emulator.dispose(); }
});

test("invalid native TypeSafe responses stop before executing inputs", async () => {
  const edits: ((value: ReturnType<typeof nativeResult>) => void)[] = [
    (value) => { value.answers.next_action.choice = "press_right"; },
    (value) => { value.answers.next_action.probabilities = { wait: 1 }; },
    (value) => { value.answers.next_action.probabilities = { wait: 0, stop: 1 }; },
    (value) => { value.answers.next_action.probabilities = { wait: 0, stop: 0 }; },
    (value) => { value.answers.next_action.confidence = 2; },
    (value) => { Reflect.deleteProperty(value.answers.next_action, "confidence"); },
    (value) => { Reflect.deleteProperty(value.answers.next_action, "probabilities"); },
    (value) => { Reflect.deleteProperty(value, "usage"); },
    (value) => { value.usage.input_tokens = -1; },
    (value) => { Reflect.deleteProperty(value, "model"); },
  ];
  for (const edit of edits) {
    const emulator = new GameBoyEmulator(createDemoRom()); const budget = limits();
    const response = nativeResult(initialContext(emulator)); edit(response);
    const decider = createDecisionProvider("typesafe", { environment, budget, fetch: async () => Response.json(response) });
    const session = new AgentSession(emulator, { mode: "typesafe", visionProvider: "none", objectives, decider,
      observer: createStateObserver(bindGameReader(new DemoGameReader(), emulator, 24)), budget,
      actionFrames: 24, maxDecisions: 2, maxSeconds: 60,
    });
    try {
      session.tick(1); await session.waitForPending();
      assert.equal(session.snapshot.state, "error"); assert.equal(session.snapshot.decisions, 0);
      assert.equal(emulator.frameNumber, 0); assert.equal(budget.requests, 1);
    } finally { session.stop("Test finished."); emulator.dispose(); }
  }
});

test("direct TypeSafe accepts bounded hundredths rounding while preserving the returned choice and probabilities", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const context = { ...initialContext(emulator), actions: controllerActions(emulator.descriptor.buttons, 8).filter((action) => action.buttons.length <= 1) };
  // A synthetic response matching the precision observed in a local direct-API session.
  const probabilities = { press_up: 0.02, press_down: 0.02, press_left: 0.01, press_right: 0,
    press_a: 0.23, press_b: 0.02, press_start: 0.31, press_select: 0.02, wait: 0.34, stop: 0.03 };
  try {
    for (const press_up of [0.01, 0.03]) {
      const response = nativeResult(context); response.answers.next_action.probabilities = { ...probabilities, press_up };
      const provider = createDecisionProvider("typesafe", { environment, budget: limits(), fetch: async () => Response.json(response) });
      const decision = await provider.decide(context, new AbortController().signal);
      assert.equal(decision.actionId, "wait");
      assert.deepEqual(decision.probabilities, response.answers.next_action.probabilities);
    }
    for (const invalid of [
      { ...probabilities, wait: 0.44 }, // Sum 1.10 is beyond the rounding cap.
      { ...probabilities, wait: 0.25 }, // A different action has the highest probability.
    ]) {
      const response = nativeResult(context); response.answers.next_action.probabilities = invalid;
      const provider = createDecisionProvider("typesafe", { environment, budget: limits(), fetch: async () => Response.json(response) });
      await assert.rejects(provider.decide(context, new AbortController().signal), /probabilities sum|highest returned probability/);
    }
    const precise = nativeResult(initialContext(emulator));
    precise.answers.next_action.probabilities = { wait: 0.5012, stop: 0.5038 };
    const provider = createDecisionProvider("typesafe", { environment, budget: limits(), fetch: async () => Response.json(precise) });
    await assert.rejects(provider.decide(initialContext(emulator), new AbortController().signal), /probabilities sum/);
    const many = { ...context, actions: Array.from({ length: 255 }, (_, index) => ({
      id: `option_${index}`, description: "Bounded fixture wait", buttons: [], frames: 1, stop: false,
    })) };
    for (const firstProbability of [0, 0.9]) {
      const response = nativeResult(many, "option_0"); response.answers.next_action.probabilities.option_0 = firstProbability;
      const provider = createDecisionProvider("typesafe", { environment, budget: limits(), fetch: async () => Response.json(response) });
      await assert.rejects(provider.decide(many, new AbortController().signal), /probabilities sum/);
    }
  } finally { emulator.dispose(); }
});

test("direct TypeSafe authentication errors stay private and overload retries count every attempt", async () => {
  const emulator = new GameBoyEmulator(createDemoRom()); const context = initialContext(emulator);
  try {
    const authBudget = limits(1);
    const failing = createDecisionProvider("typesafe", { environment, budget: authBudget,
      fetch: async () => Response.json({ error: environment.TYPESAFE_API_KEY }, { status: 401 }),
    });
    await assert.rejects(failing.decide(context, new AbortController().signal), (error: Error) => {
      assert.match(error.message, /TYPESAFE_API_KEY/);
      assert.doesNotMatch(error.message, /AI_GATEWAY_API_KEY|private-typesafe-fixture/); return true;
    });
    assert.equal(authBudget.requests, 1);
    const retryBudget = limits(1); let attempts = 0;
    const retrying = createDecisionProvider("typesafe", { environment, budget: retryBudget,
      fetch: async () => ++attempts === 1 ? Response.json({ error: "overloaded" }, { status: 529 }) : Response.json(nativeResult(context)),
    });
    assert.equal((await retrying.decide(context, new AbortController().signal)).actionId, "wait");
    assert.equal(attempts, 2); assert.equal(retryBudget.requests, 2);
  } finally { emulator.dispose(); }
});

test("pausing a direct TypeSafe request aborts it and discards any pending decision", async () => {
  const emulator = new GameBoyEmulator(createDemoRom()); const budget = limits(); let receivedSignal: AbortSignal | undefined;
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const decider = createDecisionProvider("typesafe", { environment, budget, fetch: (_input, init) => {
    receivedSignal = init!.signal as AbortSignal; markStarted();
    return new Promise<Response>((_resolve, reject) => receivedSignal!.addEventListener("abort", () => reject(receivedSignal!.reason), { once: true }));
  } });
  const session = new AgentSession(emulator, { mode: "typesafe", visionProvider: "none", objectives, decider,
    observer: createStateObserver(bindGameReader(new DemoGameReader(), emulator, 24)), budget,
    actionFrames: 24, maxDecisions: 2, maxSeconds: 60,
  });
  try {
    session.tick(1); await started; session.pause(); await session.waitForPending();
    assert.equal(receivedSignal!.aborted, true); assert.equal(session.snapshot.state, "paused");
    assert.equal(emulator.frameNumber, 0); assert.equal(session.snapshot.decisions, 0); assert.equal(budget.requests, 1);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("direct HTTP rejects oversized, non-JSON, and malformed bodies without exposing response text", async () => {
  const emulator = new GameBoyEmulator(createDemoRom()); const context = initialContext(emulator);
  try {
    for (const response of [
      () => new Response(environment.TYPESAFE_API_KEY, { headers: { "Content-Type": "text/html" } }),
      () => new Response('{"key":"private-typesafe-fixture",broken}', { headers: { "Content-Type": "application/json" } }),
      () => Response.json({ body: "x".repeat(262_144), key: environment.TYPESAFE_API_KEY }),
    ]) {
      const budget = limits();
      const provider = createDecisionProvider("typesafe", { environment, budget, fetch: async () => response() });
      await assert.rejects(provider.decide(context, new AbortController().signal), (error: Error) => {
        assert.doesNotMatch(error.message, /private-typesafe-fixture|broken/); return true;
      });
      assert.equal(budget.requests, 1);
    }
  } finally { emulator.dispose(); }
});

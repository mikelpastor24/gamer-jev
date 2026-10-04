import assert from "node:assert/strict";
import { test } from "node:test";
import type { Decision, DecisionContext, DecisionInspectionEvent, DecisionInspectionSink } from "../src/core/agent.js";
import { redactLogEvent } from "../src/core/redaction.js";
import { createDemoRom } from "../src/demo/rom.js";
import { GameBoyEmulator } from "../src/emulator/game-boy/game-boy-emulator.js";
import { createDecisionProvider } from "../src/providers/factory.js";
import { RequestBudget } from "../src/providers/requests.js";
import { bindGameReader } from "../src/profiles/registry.js";
import { DemoGameReader } from "../src/profiles/demo.js";
import { createStateObserver } from "../src/observation/state.js";
import { AgentSession } from "../src/runner/agent-session.js";
import { startViewer } from "../src/server/viewer.js";
import { evaluationRequest } from "../src/jev/evaluation.js";

const secret = "private-inspection-key";
const limits = () => new RequestBudget({ maxRequests: 5, timeoutMs: 1000, intervalMs: 0, retries: 0 });
const objectives = { goal: "Inspect the fixture", constraints: [`Protect ${secret}`], milestones: [] };

test("compact Jev requests preserve semantic state and action outcomes while retaining independent visual evidence", () => {
  const context: DecisionContext = { objectives, console: "fixture", frame: 42,
    observation: `Structured game state from fixture (full values in gameState): ${"duplicated evidence".repeat(250)}`,
    gameState: { source: "fixture", frame: 42, values: { activeMilestone: "reach_target", targetDistance: 4 },
      descriptions: { targetDistance: "Remaining local steps" }, decisionSupport: { facts: ["A target is reachable."], actionFacts: {} } },
    unchangedScreens: 0, actions: [{ id: "approach_target", description: "Approach the supplied target", buttons: [], frames: 600, stop: false, execution: "profile" }],
    history: Array.from({ length: 12 }, (_, index) => ({ actionId: "approach_target", fromFrame: index, toFrame: index + 1,
      observation: "Old structured evidence ".repeat(60), interrupted: false, executionReason: "Map changed.",
      result: { frame: index + 1, screenChanged: true, stateChanged: true, changedFieldCount: 1,
        changes: [{ field: "targetDistance", before: 5, after: 4 }] } })) };
  const request = evaluationRequest(context, "fixture");
  assert.deepEqual(request.state.gameState, context.gameState);
  assert.deepEqual(request.state.objectives, context.objectives); assert.deepEqual(request.state.actions, context.actions);
  assert.deepEqual(request.state.history.map(entry => entry.result), context.history.map(entry => entry.result));
  assert.equal(request.state.history[0]!.executionReason, "Map changed.");
  assert.ok(JSON.stringify(request).length < JSON.stringify(context).length / 2);
  const visual = "The screenshot shows a transient warning that memory does not expose.";
  assert.equal(evaluationRequest({ ...context, observation: visual }, "fixture").state.observation, visual);
});

test("both Jev adapters inspect the actual request and only supported response fields without exposing credentials", async () => {
  const context: DecisionContext = { objectives, console: "fixture", frame: 42, observation: "Menu",
    gameState: { source: "fixture", frame: 42, values: { phase: "transition" }, descriptions: {},
      decisionSupport: { facts: ["The fixture is transitioning."], actionFacts: { wait: ["Wait for stable input."] } } },
    unchangedScreens: 0, history: [], actions: [{ id: "wait", description: "Wait safely", buttons: [], frames: 8, stop: false }] };
  for (const mode of ["typesafe", "gateway"] as const) {
    const inspected: DecisionInspectionEvent[] = [];
    let sent: unknown;
    const provider = createDecisionProvider(mode, { environment: { TYPESAFE_API_KEY: secret, AI_GATEWAY_API_KEY: secret }, budget: limits(),
      fetch: async (_input, init) => {
        assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${secret}`);
        sent = JSON.parse(String(init?.body));
        return Response.json({ model: mode === "typesafe" ? "jev-fixture" : "typesafe-ai/jev",
          answers: { next_action: { type: "choice", choice: "wait", probabilities: { wait: 1 }, confidence: 0.8 } },
          usage: mode === "typesafe" ? { input_tokens: 12, output_tokens: 3 } : { inputTokens: 12, outputTokens: 3 },
          providerMetadata: { typesafe: { confidence: { next_action: 0.8 } } },
          headers: { Authorization: `Bearer ${secret}` }, unexpected: "DO_NOT_EXPOSE_PROVIDER_BODY",
        });
      },
    });
    const decision = await provider.decide(context, new AbortController().signal, (event) => inspected.push(event));
    assert.deepEqual((sent as { state: DecisionContext }).state.gameState!.decisionSupport, context.gameState!.decisionSupport);
    const request = inspected.find((event) => event.type === "request")!;
    const response = inspected.find((event) => event.type === "response")!;
    assert.equal(request.type, "request"); assert.equal(response.type, "response");
    assert.deepEqual(request.data, redactLogEvent(sent, [secret]));
    assert.deepEqual((response.data.answers as Record<string, unknown>).next_action,
      mode === "typesafe" ? { type: "choice", choice: "wait", probabilities: { wait: 1 }, confidence: 0.8 } :
        { type: "choice", choice: "wait", probabilities: { wait: 1 } });
    assert.doesNotMatch(JSON.stringify(inspected), /private-inspection-key|DO_NOT_EXPOSE_PROVIDER_BODY|Authorization/);
    assert.match(JSON.stringify(sent), /private-inspection-key/); // Inspection cannot mutate the actual request.
    assert.equal(decision.actionId, "wait"); assert.equal(decision.confidence, 0.8);
  }
});

test("the dashboard exposes a matching request, response, and warning while status stays small and inspection stays read-only", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const budget = limits();
  let sent: Record<string, unknown> = {};
  const decider = createDecisionProvider("typesafe", { environment: { TYPESAFE_API_KEY: secret }, budget,
    fetch: async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ model: "jev-fixture", answers: { next_action: {
        type: "choice", choice: "wait", probabilities: { wait: 0.49, stop: 0.51 }, confidence: 0.4,
      } }, usage: { input_tokens: 12, output_tokens: 3 }, unexpected: secret });
    },
  });
  const session = new AgentSession(emulator, { mode: "typesafe", visionProvider: "none", objectives, budget,
    observer: createStateObserver(bindGameReader(new DemoGameReader(), emulator, 8)), decider,
    actionFrames: 8, maxDecisions: 2, maxSeconds: 60, redactInspection: (value) => redactLogEvent(value, [secret]),
  });
  session.tick(1); await session.waitForPending();
  const viewer = await startViewer(emulator, { port: 0, speed: 1, paused: true, agent: session, checkpointPath: "unused-checkpoint.json" });
  try {
    const inspection = await (await fetch(`${viewer.url}/api/jev-exchange`)).json();
    assert.equal(inspection.exchange.status, "complete"); assert.equal(inspection.exchange.id, 1);
    assert.equal(inspection.exchange.frame, 0); assert.equal(inspection.exchange.provider, "typesafe");
    assert.deepEqual(inspection.exchange.request, redactLogEvent(sent, [secret]));
    assert.equal(inspection.exchange.response.answers.next_action.choice, "wait");
    assert.deepEqual(inspection.exchange.response.answers.next_action.probabilities, { wait: 0.49, stop: 0.51 });
    assert.equal(inspection.exchange.decision.actionId, "wait"); assert.equal(inspection.exchange.warnings.length, 1);
    assert.match(inspection.exchange.warnings[0], /choice was preserved/);
    assert.doesNotMatch(JSON.stringify(inspection), /private-inspection-key|unexpected/);
    const status = await (await fetch(`${viewer.url}/api/status`)).json();
    assert.equal(status.agent.exchange.revision, inspection.revision);
    assert.equal(status.agent.exchange.request, undefined); assert.equal(status.agent.exchange.response, undefined);
    assert.equal(emulator.frameNumber, 0); assert.equal(budget.requests, 1);
    const copy = session.inspection.exchange!;
    (copy.request as Record<string, unknown>).model = "changed";
    assert.equal(session.inspection.exchange!.request.model, "jev-latest");
    const reset = await fetch(`${viewer.url}/api/reset`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: viewer.url }, body: "{}" });
    assert.equal(reset.status, 200);
    const cleared = await (await fetch(`${viewer.url}/api/jev-exchange`)).json();
    assert.equal(cleared.exchange, null); assert.ok(cleared.revision > inspection.revision);
  } finally { await viewer.close(); emulator.dispose(); }
});

test("rejected native response fields and a safe error remain visible without executing the action", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  const budget = limits();
  const decider = createDecisionProvider("typesafe", { environment: { TYPESAFE_API_KEY: secret }, budget,
    fetch: async () => Response.json({ model: "jev-fixture", answers: { next_action: {
      type: "choice", choice: "wait", probabilities: { wait: 0.8, stop: 0 }, confidence: 0.4,
    } }, usage: { input_tokens: 12, output_tokens: 3 }, unexpected: secret }),
  });
  const session = new AgentSession(emulator, { mode: "typesafe", visionProvider: "none", objectives,
    observer: createStateObserver(bindGameReader(new DemoGameReader(), emulator, 8)), decider, budget,
    actionFrames: 8, maxDecisions: 2, maxSeconds: 60,
  });
  try {
    session.tick(1); await session.waitForPending();
    const exchange = session.inspection.exchange!;
    assert.equal(exchange.status, "error"); assert.equal(exchange.decision, null);
    assert.match(exchange.error!, /probabilities sum/);
    assert.deepEqual((exchange.response!.answers as Record<string, Record<string, unknown>>).next_action!.probabilities, { wait: 0.8, stop: 0 });
    assert.equal(emulator.frameNumber, 0); assert.equal(session.snapshot.decisions, 0);
    assert.doesNotMatch(JSON.stringify(exchange), /private-inspection-key|unexpected/);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("pause and reset invalidate pending inspection and discard callbacks from obsolete decisions", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  let inspect: DecisionInspectionSink | undefined;
  let finish: (decision: Decision) => void = () => {};
  let start: () => void = () => {};
  const started = new Promise<void>((resolve) => { start = resolve; });
  const session = new AgentSession(emulator, { mode: "mock", visionProvider: "none", objectives, budget: limits(),
    observer: createStateObserver(bindGameReader(new DemoGameReader(), emulator, 8)),
    decider: { decide(_context, _signal, sink) { inspect = sink; start(); return new Promise((resolve) => { finish = resolve; }); } },
    actionFrames: 8, maxDecisions: 2, maxSeconds: 60,
  });
  try {
    session.tick(1); await started;
    assert.equal(session.inspection.exchange!.status, "pending");
    session.pause();
    assert.equal(session.inspection.exchange!.status, "cancelled");
    inspect!({ type: "response", data: { stale: "Discard this" } });
    assert.equal(session.inspection.exchange!.response, null);
    session.clearHistory(); assert.equal(session.inspection.exchange, null);
    inspect!({ type: "request", data: { stale: "Discard this too" } });
    finish({ actionId: "wait", confidence: 1, probabilities: { wait: 1, stop: 0 }, model: "fixture", usage: { inputTokens: 0, outputTokens: 0 } });
    await session.waitForPending();
    assert.equal(session.inspection.exchange, null); assert.equal(session.snapshot.decisions, 0);
    assert.equal(emulator.frameNumber, 0);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

test("the last completed exchange remains available while the next request is pending", async () => {
  const emulator = new GameBoyEmulator(createDemoRom());
  let calls = 0;
  let finish: (decision: Decision) => void = () => {};
  const decision = { actionId: "wait", confidence: 1, probabilities: { wait: 1, stop: 0 }, model: "fixture", usage: { inputTokens: 0, outputTokens: 0 } };
  const session = new AgentSession(emulator, { mode: "mock", visionProvider: "none", objectives, budget: limits(),
    observer: createStateObserver(bindGameReader(new DemoGameReader(), emulator, 8)),
    decider: { async decide() { if (++calls === 1) return decision; return new Promise((resolve) => { finish = resolve; }); } },
    actionFrames: 8, maxDecisions: 2, maxSeconds: 60,
  });
  try {
    session.tick(1); await session.waitForPending(); session.tick(8);
    session.tick(1); await Promise.resolve();
    const inspected = session.inspection;
    assert.equal(inspected.exchange!.status, "pending"); assert.equal(inspected.exchange!.id, 2);
    assert.equal(inspected.exchange!.frame, 8); assert.equal(inspected.exchange!.response, null);
    assert.equal(inspected.completed!.id, 1); assert.equal(inspected.completed!.frame, 0);
    assert.equal(inspected.completed!.decision!.actionId, "wait");
    session.pause(); assert.equal(session.inspection.completed!.id, 1);
    finish(decision); await session.waitForPending();
    session.clearHistory(); assert.equal(session.inspection.completed, null);
  } finally { session.stop("Test finished."); emulator.dispose(); }
});

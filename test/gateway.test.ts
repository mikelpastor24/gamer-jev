import assert from "node:assert/strict";
import { test } from "node:test";
import { createGatewayDecisionProvider } from "../src/jev/gateway.js";
import { createGatewayVisionProvider } from "../src/vision/gateway.js";
import { RequestBudget } from "../src/providers/requests.js";
import { controllerActions } from "../src/runner/agent-session.js";
import type { DiagnosticEvent } from "../src/core/diagnostics.js";

function createGatewayProviders(options: { apiKey: string; visionModel: string; jevModel: string; budget: RequestBudget; fetch?: typeof globalThis.fetch }) {
  return { decider: createGatewayDecisionProvider({ ...options, model: options.jevModel }),
    observer: createGatewayVisionProvider({ ...options, model: options.visionModel }) };
}

test("Gateway HTTP sends vision images and typed Jev choices using the same server-side key", async () => {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const budget = new RequestBudget({ maxRequests: 4, timeoutMs: 1000, intervalMs: 0, retries: 0 });
  const providers = createGatewayProviders({ apiKey: "test-key-never-expose", visionModel: "google/gemini-2.5-flash", jevModel: "typesafe-ai/jev", budget,
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const body = url.endsWith("/chat/completions") ? {
        choices: [{ message: { content: "A title screen says PRESS START." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      } : {
        answers: { next_action: { type: "choice", choice: "press_start", probabilities: { press_start: 1, wait: 0, stop: 0 } } },
        usage: { inputTokens: 24, outputTokens: 0 }, providerMetadata: { typesafe: { confidence: { next_action: 0.85 } } },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const frame = { number: 1, width: 2, height: 2, format: "rgba8888" as const, pixels: new Uint8Array(16).fill(255) };
  const objectives = { goal: "Start the game", constraints: [], milestones: [] };
  const signal = new AbortController().signal;
  const observed = await providers.observer.observe(frame, undefined, objectives, signal);
  assert.equal(observed.text, "A title screen says PRESS START.");
  assert.equal(observed.usage.inputTokens, 12);
  const context = { objectives, console: "test-console", frame: 1, observation: observed.text, unchangedScreens: 0,
    history: [], actions: controllerActions(["START"], 24) };
  const decision = await providers.decider.decide(context, signal);
  assert.equal(decision.actionId, "press_start"); assert.equal(decision.confidence, 0.85);
  assert.equal(decision.usage.inputTokens, 24); assert.equal(budget.requests, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.url, "https://ai-gateway.vercel.sh/v1/chat/completions");
  assert.equal(requests[0]!.body.model, "google/gemini-2.5-flash");
  assert.match(JSON.stringify(requests[0]!.body), /image\/png/);
  assert.equal(requests[1]!.url, "https://ai-gateway.vercel.sh/v1/evaluate");
  assert.equal(requests[1]!.body.model, "typesafe-ai/jev");
  for (const request of requests) {
    assert.equal(request.headers.get("authorization"), "Bearer test-key-never-expose");
    assert.doesNotMatch(JSON.stringify(request.body), /test-key-never-expose/);
  }
  const state = requests[1]!.body.state as typeof context;
  assert.equal(state.observation, observed.text); assert.equal(state.objectives.goal, objectives.goal);
  const question = (requests[1]!.body.questions as { next_action: { type: string; criteria: object } }).next_action;
  assert.equal(question.type, "choice"); assert.deepEqual(Object.keys(question.criteria), ["press_start", "wait", "stop"]);
});

test("malformed Gateway choices and credential errors cannot expose provider responses", async () => {
  assert.throws(() => createGatewayProviders({ apiKey: "", visionModel: "google/test", jevModel: "typesafe-ai/jev",
    budget: new RequestBudget({ maxRequests: 2, timeoutMs: 1000, intervalMs: 0, retries: 0 }) }), /AI_GATEWAY_API_KEY/);
  const context = { objectives: { goal: "Test", constraints: [], milestones: [] }, console: "test", frame: 1,
    observation: "Menu", unchangedScreens: 0, history: [], actions: controllerActions(["START"], 24) };
  for (const status of [200, 401]) {
    let calls = 0;
    const providers = createGatewayProviders({ apiKey: "private-test-key", visionModel: "google/test", jevModel: "typesafe-ai/jev",
      budget: new RequestBudget({ maxRequests: 2, timeoutMs: 1000, intervalMs: 0, retries: 0 }),
      fetch: async () => { calls++; return new Response(JSON.stringify(status === 200 ? {
        answers: { next_action: { type: "choice", choice: "UNLISTED", probabilities: { UNLISTED: 1 } } },
      } : { error: { message: "private-test-key" } }), { status, headers: { "Content-Type": "application/json" } }); },
    });
    await assert.rejects(providers.decider.decide(context, new AbortController().signal), (error: Error) => {
      assert.doesNotMatch(error.message, /private-test-key/); return true;
    });
    assert.equal(calls, 1);
  }
});

test("malformed probabilities, confidence, and visual observations cannot become controller actions", async () => {
  const context = { objectives: { goal: "Test", constraints: [], milestones: [] }, console: "test", frame: 1,
    observation: "Menu", unchangedScreens: 0, history: [], actions: controllerActions(["START"], 24) };
  const invalid = [
    { answers: { next_action: { type: "choice", choice: "press_start", probabilities: { press_start: 1 } } } },
    { answers: { next_action: { type: "choice", choice: "press_start", probabilities: { press_start: -0.1, wait: 1.1, stop: 0 } } } },
    { answers: { next_action: { type: "choice", choice: "press_start", probabilities: { press_start: 0, wait: 0, stop: 0 } } } },
    { answers: { next_action: { type: "choice", choice: "press_start" } }, providerMetadata: { typesafe: { confidence: { next_action: 2 } } } },
  ];
  for (const body of invalid) {
    const budget = new RequestBudget({ maxRequests: 2, timeoutMs: 1000, intervalMs: 0, retries: 1 });
    const providers = createGatewayProviders({ apiKey: "test-key", visionModel: "google/test", jevModel: "typesafe-ai/jev", budget,
      fetch: async () => Response.json(body),
    });
    await assert.rejects(providers.decider.decide(context, new AbortController().signal));
    assert.equal(budget.requests, 1);
  }
  const providers = createGatewayProviders({ apiKey: "test-key", visionModel: "google/test", jevModel: "typesafe-ai/jev",
    budget: new RequestBudget({ maxRequests: 2, timeoutMs: 1000, intervalMs: 0, retries: 0 }),
    fetch: async () => Response.json({ choices: [{ message: { content: " " } }] }),
  });
  await assert.rejects(providers.observer.observe({ number: 1, width: 1, height: 1, format: "rgba8888", pixels: new Uint8Array(4) },
    undefined, context.objectives, new AbortController().signal), /empty/);
});

test("Gateway preserves a listed Jev choice and warns about a different distribution ranking", async () => {
  const events: DiagnosticEvent[] = [];
  const probabilities = { press_start: 0.1, wait: 0.9, stop: 0 };
  const budget = new RequestBudget({ maxRequests: 2, timeoutMs: 1000, intervalMs: 0, retries: 0 });
  const provider = createGatewayDecisionProvider({ apiKey: "test-key", model: "typesafe-ai/jev", budget,
    diagnostics: (event) => { events.push(event); },
    fetch: async () => Response.json({ answers: { next_action: { type: "choice", choice: "press_start", probabilities } } }),
  });
  const context = { objectives: { goal: "Test", constraints: [], milestones: [] }, console: "test", frame: 42,
    observation: "Menu", unchangedScreens: 0, history: [], actions: controllerActions(["START"], 8) };
  const decision = await provider.decide(context, new AbortController().signal);
  assert.equal(decision.actionId, "press_start"); assert.deepEqual(decision.probabilities, probabilities);
  assert.equal(budget.requests, 1);
  const warning = events.find((event) => event.event === "choice-probability-mismatch")!;
  assert.equal(warning.level, "warn"); assert.equal(warning.frame, 42);
  assert.deepEqual(warning.data!.highestProbabilityActions, ["wait"]);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { AgentSettings, DecisionContext, PlayerSelection } from "../src/core/agent.js";
import { parseCliOptions } from "../src/config/cli-options.js";
import { providerCatalog } from "../src/config/player-settings.js";
import { createDemoRom } from "../src/demo/rom.js";
import { createGameRuntime } from "../src/runner/game-runtime.js";
import { startViewer } from "../src/server/viewer.js";
import { LocalRomLibrary } from "../src/server/rom-library.js";

const options = () => parseCliOptions([]);
const settings: AgentSettings = { objectives: { goal: "Inspect the game", constraints: [], milestones: [] },
  maxDecisions: null, maxRequests: null, maxSeconds: null, actionFrames: 3 };
const selection: PlayerSelection = { mode: "agent", decisionProvider: "mock", visionProvider: "none", decisionModel: "", visionModel: "" };
const environment = { TYPESAFE_API_KEY: "private-typesafe-player", AI_GATEWAY_API_KEY: "private-gateway-player" };

function result(body: Record<string, unknown>, native = true) {
  const context = body.state as DecisionContext;
  const answers = { next_action: { type: "choice", choice: "wait", confidence: 1,
    probabilities: Object.fromEntries(context.actions.map((action) => [action.id, action.id === "wait" ? 1 : 0])) } };
  return native ? { model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 1 } } :
    { answers, usage: { inputTokens: 1, outputTokens: 1 }, providerMetadata: { typesafe: { confidence: { next_action: 1 } } } };
}

test("provider availability excludes empty and placeholder keys and never includes credentials", () => {
  for (const keys of [{}, { TYPESAFE_API_KEY: " ", AI_GATEWAY_API_KEY: "replace-with-your-vercel-ai-gateway-key" }]) {
    const catalog = providerCatalog(keys);
    assert.deepEqual(catalog.decisions.map((item) => item.available), [false, false, true]);
    assert.deepEqual(catalog.vision.map((item) => item.available), [true, false, true]);
  }
  const catalog = providerCatalog(environment);
  assert.ok(catalog.decisions.every((item) => item.available));
  assert.doesNotMatch(JSON.stringify(catalog), /private-(typesafe|gateway)-player/);
});

test("manual play can enable independent providers in place while preserving counters, budgets, and emulator state", async () => {
  const calls: { url: string; key: string | null; model: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input); const body = JSON.parse(String(init?.body));
    calls.push({ url, key: new Headers(init?.headers).get("authorization"), model: body.model });
    return Response.json(url.endsWith("/chat/completions") ? { choices: [{ message: { content: "A checkerboard is visible." } }] } : result(body, url.endsWith("/systemone")));
  };
  const runtime = await createGameRuntime(createDemoRom(), options(), undefined, false, { environment, fetch: transport });
  const player = runtime.player!;
  try {
    runtime.emulator.advance({ buttons: [], frames: 12 }); const before = runtime.emulator.saveState();
    player.configure({ ...selection, decisionProvider: "typesafe", decisionModel: "jev-latest" }, settings, 0);
    const session = runtime.agent!;
    assert.equal(calls.length, 0); assert.equal(session.snapshot.state, "paused"); assert.deepEqual(runtime.emulator.saveState(), before);
    session.resume(); session.tick(1); await session.waitForPending(); session.tick(3);
    assert.equal(session.snapshot.decisions, 1); assert.equal(session.snapshot.requests, 1);
    const elapsed = session.snapshot.elapsedSeconds;
    player.configure({ ...selection, decisionProvider: "gateway", decisionModel: "typesafe-ai/jev", visionProvider: "gateway", visionModel: "google/fixture-vision" }, settings, player.configuration.revision);
    assert.equal(runtime.agent, session); assert.equal(session.snapshot.decisions, 1); assert.equal(session.snapshot.requests, 1);
    assert.ok(session.snapshot.elapsedSeconds >= elapsed); assert.equal(session.inspection.exchange, null);
    session.resume(); session.tick(1); await session.waitForPending(); session.tick(3);
    assert.equal(session.snapshot.decisions, 2); assert.equal(session.snapshot.requests, 3);
    assert.deepEqual(calls.map((call) => call.key), [`Bearer ${environment.TYPESAFE_API_KEY}`, `Bearer ${environment.AI_GATEWAY_API_KEY}`, `Bearer ${environment.AI_GATEWAY_API_KEY}`]);
    assert.deepEqual(calls.map((call) => call.model), ["jev-latest", "google/fixture-vision", "typesafe-ai/jev"]);
    player.configure({ ...player.copySelection(), mode: "manual" }, null, player.configuration.revision);
    assert.equal(runtime.agent, undefined); const count = calls.length;
    runtime.emulator.advance({ buttons: ["RIGHT"], frames: 5 });
    player.configure(selection, null, player.configuration.revision);
    assert.equal(runtime.agent, session); assert.equal(session.snapshot.decisions, 2); assert.equal(session.snapshot.requests, 3);
    assert.equal(calls.length, count); assert.equal(session.snapshot.mode, "mock");
    const exposed = JSON.stringify(player.configuration) + JSON.stringify(session.inspection);
    assert.doesNotMatch(exposed, /private-(typesafe|gateway)-player/);
    runtime.dispose();
    assert.doesNotMatch(await readFile(runtime.logPath!, "utf8"), /private-(typesafe|gateway)-player/);
  } finally { runtime.dispose(); }
});

test("invalid models, missing keys, missing goals, and stale edits cannot interrupt a running player", async () => {
  const runtime = await createGameRuntime(createDemoRom(), options(), undefined, false, { environment: {} });
  const player = runtime.player!;
  try {
    assert.throws(() => player.configure(selection, null, 0), /objective/);
    assert.throws(() => player.configure({ ...selection, decisionProvider: "typesafe", decisionModel: "jev-latest" }, settings, 0), /TYPESAFE_API_KEY/);
    assert.equal(player.configuration.revision, 0); assert.equal(runtime.agent, undefined);
    player.configure(selection, settings, 0); runtime.agent!.resume();
    const before = player.configuration;
    for (const next of [{ ...selection, apiKey: "browser-secret" }, { ...selection, visionProvider: "gateway", visionModel: "invalid" },
      { ...selection, decisionProvider: "gateway", decisionModel: "typesafe-ai/jev" }, { ...selection, decisionModel: "x".repeat(161) }]) {
      assert.throws(() => player.configure(next, settings, before.revision));
      assert.deepEqual(player.configuration, before); assert.equal(runtime.agent!.snapshot.state, "idle");
    }
    assert.throws(() => player.configure(selection, settings, 0), /another window/);
  } finally { runtime.dispose(); }
});

test("manual setup can save limits and constraints before supplying the required agent objective", async () => {
  const runtime = await createGameRuntime(createDemoRom(), options(), undefined, false, { environment: {} });
  const player = runtime.player!;
  const draft = { ...settings, actionFrames: 8, objectives: { goal: "", constraints: ["Avoid waste"], milestones: [] } };
  try {
    player.configure({ ...selection, mode: "manual" }, draft, 0);
    assert.deepEqual(player.configuration.settings, draft);
    assert.equal(runtime.agent, undefined);
    assert.throws(() => player.configure(selection, null, player.configuration.revision), /nonempty goal/);
    player.configure(selection, settings, player.configuration.revision);
    const session = runtime.agent!;
    player.configure({ ...selection, mode: "manual" }, draft, player.configuration.revision);
    assert.equal(runtime.agent, undefined); assert.equal(session.snapshot.goal, settings.objectives.goal);
    assert.deepEqual(player.copySettings(), draft);
    player.configure(selection, settings, player.configuration.revision);
    assert.equal(runtime.agent, session); assert.equal(session.snapshot.state, "paused");
  } finally { runtime.dispose(); }
});

test("switching to manual cancels an in-flight remote decision and preserves its counted attempt", async () => {
  let finish: ((response: Response) => void) | undefined;
  let requestSignal: AbortSignal | undefined;
  const transport: typeof fetch = async (_input, init) => {
    requestSignal = init?.signal ?? undefined;
    return new Promise<Response>((resolve) => { finish = resolve; });
  };
  const runtime = await createGameRuntime(createDemoRom(), options(), undefined, false, { environment, fetch: transport });
  const player = runtime.player!;
  try {
    player.configure({ ...selection, decisionProvider: "typesafe", decisionModel: "jev-latest" }, settings, 0);
    const session = runtime.agent!; session.resume(); session.tick(1);
    for (let attempt = 0; !finish && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(finish); const before = runtime.emulator.frameNumber;
    player.configure({ ...player.copySelection(), mode: "manual" }, null, player.configuration.revision);
    assert.equal(requestSignal!.aborted, true); assert.equal(session.snapshot.requests, 1);
    finish!(Response.json({ invalid: "late-response" })); await session.waitForPending();
    assert.equal(runtime.emulator.frameNumber, before); assert.equal(session.snapshot.decisions, 0); assert.equal(runtime.agent, undefined);
    player.configure(selection, null, player.configuration.revision);
    assert.equal(runtime.agent, session); assert.equal(session.snapshot.requests, 1);
  } finally { runtime.dispose(); }
});

test("unsupported memory-only cartridges require vision when enabling the agent without changing the game", async () => {
  const bytes = createDemoRom(); bytes[0x7fff] = 4;
  const runtime = await createGameRuntime(bytes, options(), undefined, false, { environment: {} });
  try {
    const player = runtime.player!; const before = runtime.emulator.saveState();
    assert.throws(() => player.configure(selection, settings, 0), /compatible game reader/);
    assert.deepEqual(runtime.emulator.saveState(), before); assert.equal(runtime.agent, undefined);
    player.configure({ ...selection, visionProvider: "mock" }, settings, 0);
    assert.equal(runtime.agent!.snapshot.visionProvider, "mock"); assert.equal(runtime.gameState.id, "emulator");
  } finally { runtime.dispose(); }
});

test("the player API guards stale clients and carries model choices and saved objectives through manual ROM changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamer-jev-player-"));
  const initial = await createGameRuntime(createDemoRom(), options(), undefined, false, { environment });
  await writeFile(join(directory, "Next.gb"), createDemoRom());
  const viewer = await startViewer(initial.emulator, { runtime: initial, launcher: true, port: 0, speed: 4, paused: true,
    checkpointPath: join(directory, "old.json"), checkpointDirectory: join(directory, "saves"), romLibrary: new LocalRomLibrary(directory),
    loadRom: (rom, next, chosen) => createGameRuntime(rom, options(), next, true, { environment, ...(chosen ? { selection: chosen } : {}) }) });
  const post = (path: string, body: unknown, origin = viewer.url) => fetch(`${viewer.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
  const get = async (path: string) => (await fetch(`${viewer.url}${path}`)).json();
  try {
    assert.equal((await get("/api/status")).launcher, true);
    let config = await get("/api/player-settings");
    const chosen = { ...selection, mode: "manual", decisionProvider: "typesafe", decisionModel: "jev-latest", visionProvider: "gateway", visionModel: "google/fixture-vision" };
    assert.equal((await post("/api/player-settings", { selection: chosen, settings, revision: config.revision, gameId: 0 }, "https://example.com")).status, 403);
    initial.emulator.advance({ buttons: [], frames: 12 });
    const applied = await (await post("/api/player-settings", { selection: chosen, settings, revision: config.revision, gameId: 0 })).json();
    assert.equal(applied.frame, 12); assert.equal(applied.agent, null); assert.equal(applied.paused, true);
    assert.ok(applied.gameId > 0); assert.equal(applied.playerRevision, 1);
    assert.equal((await post("/api/resume", { gameId: 0 })).status, 400);
    assert.equal((await post("/api/player-settings", { selection: chosen, settings, revision: 0, gameId: applied.gameId })).status, 400);
    config = await get("/api/player-settings"); assert.deepEqual(config.selection, chosen);
    assert.doesNotMatch(JSON.stringify(config), /private-(typesafe|gateway)-player/);
    const changed = await (await post("/api/rom", { id: "Next.gb", gameId: applied.gameId })).json();
    assert.equal(changed.agent, null); assert.equal(changed.frame, 0); assert.equal(changed.paused, true);
    config = await get("/api/player-settings"); assert.deepEqual(config.selection, chosen); assert.deepEqual(config.settings, settings);
    const agentState = await (await post("/api/player-settings", { selection: { ...chosen, mode: "agent" }, settings: null, revision: config.revision, gameId: changed.gameId })).json();
    assert.equal(agentState.agent.mode, "typesafe"); assert.equal(agentState.agent.visionProvider, "gateway"); assert.equal(agentState.agent.decisions, 0);
    assert.equal(agentState.agent.requests, 0); assert.equal(agentState.paused, true);
    const active = viewer.game.agent!;
    const legacy = await get("/api/agent-settings");
    assert.equal((await post("/api/agent-settings", { gameId: agentState.gameId, revision: legacy.revision, settings })).status, 200);
    assert.equal((await post("/api/player-settings", { gameId: agentState.gameId, revision: config.revision + 1, selection: chosen, settings })).status, 400);
    assert.equal(viewer.game.agent, active);
  } finally {
    await viewer.close(); viewer.game.dispose(); initial.dispose();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true });
  }
});

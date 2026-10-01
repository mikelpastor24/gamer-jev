import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { CLI_HELP, parseCliOptions } from "./config/cli-options.js";
import { createDemoRom } from "./demo/rom.js";
import { loadStateFile, saveScreenshot, saveStateFile } from "./emulator/files.js";
import { createDefaultRegistry } from "./emulator/registry.js";
import { runHeadless } from "./runner/headless.js";
import { startViewer } from "./server/viewer.js";
import { loadObjectives, parseObjectives } from "./config/objectives.js";
import { createGatewayDecisionProvider } from "./jev/gateway.js";
import { createMockDecisionProvider } from "./jev/mock.js";
import { RequestBudget } from "./providers/requests.js";
import { createGatewayVisionProvider } from "./vision/gateway.js";
import { createMockVisionProvider } from "./vision/mock.js";
import { createEmulatorStateProvider, createStateObserver } from "./observation/state.js";
import { withVision } from "./observation/combined.js";
import { createDefaultGameReaderRegistry } from "./profiles/default-registry.js";
import { bindGameReader } from "./profiles/registry.js";
import { loadJsonGameReader } from "./profiles/json.js";
import { AgentSession } from "./runner/agent-session.js";
import { runAgentHeadless } from "./runner/agent-headless.js";
import { openSessionLog } from "./runner/session-log.js";

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) { console.log(CLI_HELP); return; }
  const registry = createDefaultRegistry();
  const readers = createDefaultGameReaderRegistry();
  if (options.listConsoles) {
    for (const descriptor of registry.list()) console.log(`${descriptor.consoleId}: ${descriptor.name} (${descriptor.backendId} ${descriptor.backendVersion})`);
    return;
  }
  if (options.listProfiles) {
    for (const descriptor of readers.list()) console.log(`${descriptor.id}: ${descriptor.name} (${descriptor.consoleId})`);
    return;
  }
  if (options.romPath && (await stat(options.romPath)).size > 8 * 1024 * 1024) {
    throw new Error("ROM files must be at most 8 MiB.");
  }
  const rom = options.demo ? createDemoRom() : await readFile(options.romPath!);
  const emulator = await registry.create(options.consoleId, rom);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let session: AgentSession | undefined;
  let log: ReturnType<typeof openSessionLog> | undefined;
  try {
    if (options.loadPath) await loadStateFile(emulator, options.loadPath);
    console.log(`Loaded ${emulator.rom.title} on ${emulator.descriptor.name}.`);
    const profileState = options.profile && existsSync(options.profile) ?
      bindGameReader(await loadJsonGameReader(options.profile), emulator, options.actionFrames) :
      readers.createFor(emulator, options.actionFrames, options.profile);
    const gameState = profileState ?? createEmulatorStateProvider(emulator, options.actionFrames);
    gameState.read(emulator.captureFrame()); // Validate the local reader before any provider calls.
    if (profileState) console.log(`Game reader: ${profileState.id}`);
    if (options.agent) {
      if (options.observationMode === "state" && !profileState) throw new Error("Memory-only agent mode requires a compatible game reader. Supply --profile <id/path>, or use --observation vision.");
      if (options.agent === "gateway" && existsSync(".env")) loadEnvFile(".env");
      const objectives = options.objectivesPath ? await loadObjectives(options.objectivesPath) : parseObjectives({ goal: options.goal });
      const budget = new RequestBudget({ maxRequests: options.requests, timeoutMs: 20_000, intervalMs: 250, retries: 1 });
      const credentials = { apiKey: process.env.AI_GATEWAY_API_KEY ?? "", budget };
      const decider = options.agent === "mock" ? createMockDecisionProvider() :
        createGatewayDecisionProvider({ ...credentials, model: process.env.JEV_MODEL ?? "typesafe-ai/jev" });
      const stateObserver = createStateObserver(gameState);
      const observer = options.observationMode === "state" ? stateObserver : withVision(stateObserver,
        options.agent === "mock" ? createMockVisionProvider() : createGatewayVisionProvider({ ...credentials,
          model: process.env.VISION_MODEL ?? "google/gemini-2.5-flash" }));
      const logPath = join("logs", "sessions", `${randomUUID()}.jsonl`);
      log = openSessionLog(logPath);
      session = new AgentSession(emulator, { observer, decider, budget, mode: options.agent, objectives,
        actionFrames: options.actionFrames, maxDecisions: options.decisions, maxSeconds: options.maxSeconds,
        record: log.record,
      });
      console.log(`Agent: ${options.agent}. Observation: ${options.observationMode}. Goal: ${objectives.goal}`);
      console.log(`Session record: ${logPath}`);
      if (options.agent === "gateway") console.log(options.observationMode === "vision" ? "Screenshots go to the vision provider; structured state and observations go to Jev through AI Gateway." : "Structured game state goes to Jev. No vision model is initialized or called.");
      else console.log("Offline mock decisions are predetermined and make no API calls. Local game-state readers still run.");
    }
    if (options.headless) {
      const initialFrame = emulator.frameNumber;
      if (session) await runAgentHeadless(emulator, session, controller.signal, options.frames);
      else await runHeadless(emulator, options.frames, options.buttons, controller.signal);
      if (options.screenshotPath) await saveScreenshot(emulator.captureFrame(), options.screenshotPath);
      if (options.savePath) await saveStateFile(emulator, options.savePath);
      console.log(`Completed ${emulator.frameNumber - initialFrame} frames. Current frame: ${emulator.frameNumber}.${controller.signal.aborted ? " Interrupted." : ""}`);
      if (session) {
        console.log(`Agent stopped after ${session.snapshot.decisions} decisions and ${session.snapshot.requests} model attempts: ${session.snapshot.stopReason}`);
        if (session.snapshot.state === "error") process.exitCode = 1;
      }
    } else {
      const checkpointPath = options.savePath ?? join("saves", emulator.descriptor.consoleId, emulator.rom.sha256, "checkpoint.json");
      const viewer = await startViewer(emulator, {
        port: options.port, speed: options.speed, paused: options.paused, checkpointPath,
        gameState,
        ...(session ? { agent: session } : {}),
      });
      console.log(`Viewer: ${viewer.url}`);
      console.log(`Checkpoint: ${checkpointPath}`);
      console.log("Press Ctrl+C to stop.");
      try {
        if (!controller.signal.aborted) await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      } finally {
        await viewer.close();
        await saveStateFile(emulator, checkpointPath);
        console.log(`Stopped at frame ${emulator.frameNumber}. Checkpoint saved.`);
      }
    }
  } finally {
    session?.stop("Session closed.");
    log?.close();
    emulator.dispose();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : "The emulator could not start."}`);
  process.exitCode = 1;
});

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
import { RequestBudget } from "./providers/requests.js";
import { createDecisionProvider, createVisionProvider } from "./providers/factory.js";
import { createEmulatorStateProvider, createStateObserver } from "./observation/state.js";
import { withVision } from "./observation/combined.js";
import { createDefaultGameReaderRegistry } from "./profiles/default-registry.js";
import { bindGameReader } from "./profiles/registry.js";
import { loadJsonGameReader } from "./profiles/json.js";
import { AgentSession } from "./runner/agent-session.js";
import { runAgentHeadless } from "./runner/agent-headless.js";
import { openSessionLog } from "./runner/session-log.js";
import { createDiagnosticLogger } from "./runner/diagnostics.js";
import type { DiagnosticSink } from "./core/diagnostics.js";
import { redactLogEvent } from "./core/redaction.js";

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
    if ((options.agent && options.agent !== "mock" || options.visionProvider === "gateway") && existsSync(".env")) loadEnvFile(".env");
    let diagnostics: DiagnosticSink | undefined;
    const inspectionSecrets = [process.env.TYPESAFE_API_KEY, process.env.AI_GATEWAY_API_KEY].filter((value): value is string => Boolean(value));
    if (options.agent || options.debug) {
      const logPath = join("logs", "sessions", `${randomUUID()}.jsonl`);
      const secrets = [process.env.TYPESAFE_API_KEY, process.env.AI_GATEWAY_API_KEY].filter((value): value is string => Boolean(value));
      log = openSessionLog(logPath, { secrets, onLimit: () => console.error("Local session log reached 32 MiB. Further file events are omitted; gameplay continues.") });
      diagnostics = createDiagnosticLogger(log.record, { verbose: options.debug, secrets });
      console.log(`${options.agent ? "Session" : "Debug"} record: ${logPath}`);
    }
    const profileState = options.profile && existsSync(options.profile) ?
      bindGameReader(await loadJsonGameReader(options.profile), emulator, options.actionFrames, diagnostics) :
      readers.createFor(emulator, options.actionFrames, options.profile, diagnostics);
    const gameState = profileState ?? createEmulatorStateProvider(emulator, options.actionFrames);
    if (!profileState) diagnostics?.({ component: "game-reader", level: "info", event: "metadata-only", frame: emulator.frameNumber,
      data: { console: emulator.descriptor.consoleId, romSha256: emulator.rom.sha256 } });
    gameState.read(emulator.captureFrame()); // Validate the local reader before any provider calls.
    if (profileState) console.log(`Game reader: ${profileState.id}`);
    if (options.agent) {
      if (options.observationMode === "state" && !profileState) throw new Error("Memory-only agent mode requires a compatible game reader. Supply --profile <id/path>, or use --vision gateway.");
      const objectives = options.objectivesPath ? await loadObjectives(options.objectivesPath) : parseObjectives({ goal: options.goal });
      const budget = new RequestBudget({ maxRequests: options.requests, timeoutMs: 20_000, intervalMs: 250, retries: 1 }, diagnostics);
      const settings = { environment: process.env, budget, ...(diagnostics ? { diagnostics } : {}) };
      const decider = createDecisionProvider(options.agent, settings);
      const vision = createVisionProvider(options.visionProvider, settings);
      const stateObserver = createStateObserver(gameState);
      const observer = vision ? withVision(stateObserver, vision) : stateObserver;
      session = new AgentSession(emulator, { observer, decider, budget, mode: options.agent, visionProvider: options.visionProvider, objectives,
        actionFrames: options.actionFrames, maxDecisions: options.decisions, maxSeconds: options.maxSeconds,
        record: log!.record, ...(diagnostics ? { diagnostics } : {}),
        redactInspection: (value) => redactLogEvent(value, inspectionSecrets),
      });
      console.log(`Agent: ${options.agent}. Vision: ${options.visionProvider}. Observation: ${options.observationMode}. Goal: ${objectives.goal}`);
      console.log(options.agent === "mock" ? "Decisions use predetermined mock inputs without Jev API calls." :
        `Structured state and observations go to Jev ${options.agent === "typesafe" ? "directly through TypeSafe" : "through Vercel AI Gateway"}.`);
      console.log(options.visionProvider === "gateway" ? "Screenshots go to the configured vision model through Vercel AI Gateway." :
        options.visionProvider === "mock" ? "Vision uses a local mock without API calls." : "Vision is disabled. No screenshots are sent.");
    }
    if (options.headless) {
      const initialFrame = emulator.frameNumber;
      if (session) await runAgentHeadless(emulator, session, controller.signal, options.frames);
      else await runHeadless(emulator, options.frames!, options.buttons, controller.signal);
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
        ...(log ? { record: log.record } : {}),
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

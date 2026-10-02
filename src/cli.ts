import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { CLI_HELP, parseCliOptions } from "./config/cli-options.js";
import { createDemoRom } from "./demo/rom.js";
import { saveScreenshot, saveStateFile } from "./emulator/files.js";
import { createDefaultRegistry } from "./emulator/registry.js";
import { createDefaultGameReaderRegistry } from "./profiles/default-registry.js";
import { runHeadless } from "./runner/headless.js";
import { runAgentHeadless } from "./runner/agent-headless.js";
import { createGameRuntime } from "./runner/game-runtime.js";
import { startViewer } from "./server/viewer.js";
import { MAX_ROM_BYTES } from "./server/rom-library.js";

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) { console.log(CLI_HELP); return; }
  if (options.listConsoles) {
    for (const descriptor of createDefaultRegistry().list()) console.log(`${descriptor.consoleId}: ${descriptor.name} (${descriptor.backendId} ${descriptor.backendVersion})`);
    return;
  }
  if (options.listProfiles) {
    for (const descriptor of createDefaultGameReaderRegistry().list()) console.log(`${descriptor.id}: ${descriptor.name} (${descriptor.consoleId})`);
    return;
  }
  if (options.romPath && (await stat(options.romPath)).size > MAX_ROM_BYTES) throw new Error("ROM files must be at most 8 MiB.");
  const rom = options.demo ? createDemoRom() : await readFile(options.romPath!);
  if ((options.agent && options.agent !== "mock" || options.visionProvider === "gateway") && existsSync(".env")) loadEnvFile(".env");
  let runtime = await createGameRuntime(rom, options);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const { emulator, agent: session } = runtime;
    console.log(`Loaded ${emulator.rom.title} on ${emulator.descriptor.name}.`);
    if (runtime.logPath) console.log(`${options.agent ? "Session" : "Debug"} record: ${runtime.logPath}`);
    if (runtime.gameState.id !== "emulator") console.log(`Game reader: ${runtime.gameState.id}`);
    if (session) {
      console.log(`Agent: ${options.agent}. Vision: ${options.visionProvider}. Observation: ${options.observationMode}. Goal: ${session.snapshot.goal}`);
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
        gameState: runtime.gameState, dispose: runtime.dispose,
        ...(runtime.record ? { record: runtime.record } : {}), ...(session ? { agent: session } : {}),
        async loadRom(bytes, settings) {
          const next = await createGameRuntime(bytes, options, settings, true);
          if (next.logPath) console.log(`Prepared cartridge session record: ${next.logPath}`);
          return next;
        },
      });
      console.log(`Viewer: ${viewer.url}`);
      console.log(`Checkpoint: ${checkpointPath}`);
      console.log("Load another local cartridge in Settings → ROMs. Press Ctrl+C to stop.");
      try {
        if (!controller.signal.aborted) await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      } finally {
        try { await viewer.close(); } finally { runtime = viewer.game; }
        await saveStateFile(runtime.emulator, viewer.checkpointPath);
        console.log(`Stopped at frame ${runtime.emulator.frameNumber}. Checkpoint saved.`);
      }
    }
  } finally {
    runtime.dispose();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : "The emulator could not start."}`);
  process.exitCode = 1;
});

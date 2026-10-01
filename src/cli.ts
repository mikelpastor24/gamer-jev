import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CLI_HELP, parseCliOptions } from "./config/cli-options.js";
import { createDemoRom } from "./demo/rom.js";
import { loadStateFile, saveScreenshot, saveStateFile } from "./emulator/files.js";
import { createDefaultRegistry } from "./emulator/registry.js";
import { runHeadless } from "./runner/headless.js";
import { startViewer } from "./server/viewer.js";

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) { console.log(CLI_HELP); return; }
  const registry = createDefaultRegistry();
  if (options.listConsoles) {
    for (const descriptor of registry.list()) console.log(`${descriptor.consoleId}: ${descriptor.name} (${descriptor.backendId} ${descriptor.backendVersion})`);
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
  try {
    if (options.loadPath) await loadStateFile(emulator, options.loadPath);
    console.log(`Loaded ${emulator.rom.title} on ${emulator.descriptor.name}.`);
    if (options.headless) {
      const completed = await runHeadless(emulator, options.frames, options.buttons, controller.signal);
      if (options.screenshotPath) await saveScreenshot(emulator.captureFrame(), options.screenshotPath);
      if (options.savePath) await saveStateFile(emulator, options.savePath);
      console.log(`Completed ${completed} frames. Current frame: ${emulator.frameNumber}.${controller.signal.aborted ? " Interrupted." : ""}`);
    } else {
      const checkpointPath = options.savePath ?? join("saves", emulator.descriptor.consoleId, emulator.rom.sha256, "checkpoint.json");
      const viewer = await startViewer(emulator, {
        port: options.port, speed: options.speed, paused: options.paused, checkpointPath,
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
    emulator.dispose();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : "The emulator could not start."}`);
  process.exitCode = 1;
});

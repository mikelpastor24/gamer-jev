import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import type { Emulator, Frame } from "../core/emulator.js";

export async function loadStateFile(emulator: Emulator, path: string): Promise<void> {
  if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error("State files must be smaller than 32 MiB.");
  emulator.restoreState(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export function defaultCheckpointPath(emulator: Emulator, directory = "saves"): string {
  return join(directory, emulator.descriptor.consoleId, emulator.rom.sha256, "checkpoint.json");
}

/** Only a missing checkpoint permits a fresh start; invalid saves remain errors. */
export async function loadCheckpointIfPresent(emulator: Emulator, path: string): Promise<boolean> {
  try {
    await loadStateFile(emulator, path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function saveStateFile(emulator: Emulator, path: string): Promise<void> {
  const data = JSON.stringify(emulator.saveState());
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, data, { flag: "wx" });
    await rename(temporaryPath, path);
  } finally { await rm(temporaryPath, { force: true }); }
}

export function encodePng(frame: Frame): Buffer {
  const png = new PNG({ width: frame.width, height: frame.height });
  png.data = Buffer.from(frame.pixels);
  return PNG.sync.write(png);
}

export async function saveScreenshot(frame: Frame, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encodePng(frame));
}

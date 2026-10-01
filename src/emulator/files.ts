import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PNG } from "pngjs";
import type { Emulator, Frame } from "../core/emulator.js";

export async function loadStateFile(emulator: Emulator, path: string): Promise<void> {
  if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error("State files must be smaller than 32 MiB.");
  emulator.restoreState(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export async function saveStateFile(emulator: Emulator, path: string): Promise<void> {
  const data = JSON.stringify(emulator.saveState());
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
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

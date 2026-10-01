import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export function openSessionLog(path: string): { record(event: unknown): void; close(): void } {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "ax");
  return {
    record(event) { writeSync(descriptor, `${JSON.stringify({ at: new Date().toISOString(), event })}\n`); },
    close() { closeSync(descriptor); },
  };
}

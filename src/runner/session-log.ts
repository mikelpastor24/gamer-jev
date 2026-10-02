import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { redactLogEvent } from "./diagnostics.js";

interface SessionLogOptions {
  readonly secrets?: readonly string[];
  readonly maxBytes?: number;
  readonly onLimit?: () => void;
}

export function openSessionLog(path: string, options: SessionLogOptions = {}): { record(event: unknown): void; close(): void } {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512) throw new Error("Session log limit must be at least 512 bytes.");
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "ax", 0o600);
  let bytes = 0;
  let full = false;
  let closed = false;
  function write(line: string): void {
    const buffer = Buffer.from(line);
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
    bytes += buffer.length;
  }
  return {
    record(event) {
      if (closed || full) return;
      const at = new Date().toISOString();
      const line = `${JSON.stringify({ at, event: redactLogEvent(event, options.secrets) })}\n`;
      if (bytes + Buffer.byteLength(line) + 256 > maxBytes) {
        full = true;
        write(`${JSON.stringify({ at, event: { type: "log-limit", maxBytes, reason: "Local recording limit reached. Further events are omitted." } })}\n`);
        options.onLimit?.();
      } else write(line);
    },
    close() { if (!closed) { closed = true; closeSync(descriptor); } },
  };
}

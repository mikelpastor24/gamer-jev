import { closeSync, ftruncateSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { redactLogEvent } from "./diagnostics.js";

interface SessionLogOptions {
  readonly secrets?: readonly string[];
  readonly maxBytes?: number;
  /** Notify once when the oldest events are first removed. Recording continues. */
  readonly onLimit?: () => void;
}

export function openSessionLog(path: string, options: SessionLogOptions = {}): { record(event: unknown): void; close(): void } {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512) throw new Error("Session log limit must be at least 512 bytes.");
  mkdirSync(dirname(path), { recursive: true });
  // Positional writes are needed to compact the file; preserve exclusive creation.
  const descriptor = openSync(path, "wx+", 0o600);
  const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes));
  let bytes = 0;
  let notified = false;
  let closed = false;
  function write(data: Buffer, position: number): void {
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(descriptor, data, offset, data.length - offset, position + offset);
      if (written === 0) throw new Error("Session log write made no progress.");
      offset += written;
    }
  }
  function compact(requiredBytes: number): void {
    // Leave headroom so frequent diagnostics do not repeatedly copy a nearly full file.
    const target = Math.max(requiredBytes, Math.ceil(maxBytes / 4));
    let start = Math.min(bytes, target - 1);
    while (start < bytes) {
      const length = readSync(descriptor, buffer, 0, Math.min(buffer.length, bytes - start), start);
      if (length === 0) throw new Error("Session log read made no progress.");
      const newline = buffer.subarray(0, length).indexOf(0x0a);
      if (newline !== -1) { start += newline + 1; break; }
      start += length;
    }
    // Copy forward in bounded chunks. Destinations precede unread source bytes.
    let destination = 0;
    for (let source = start; source < bytes;) {
      const length = readSync(descriptor, buffer, 0, Math.min(buffer.length, bytes - source), source);
      if (length === 0) throw new Error("Session log read made no progress.");
      write(buffer.subarray(0, length), destination);
      source += length; destination += length;
    }
    ftruncateSync(descriptor, destination);
    bytes = destination;
  }
  return {
    record(event) {
      if (closed) return;
      const at = new Date().toISOString();
      let line = Buffer.from(`${JSON.stringify({ at, event: redactLogEvent(event, options.secrets) })}\n`);
      if (line.length > maxBytes) line = Buffer.from(`${JSON.stringify({ at, event: {
        type: "log-event-omitted", eventBytes: line.length, maxBytes,
        reason: "This event exceeds the recording window. Subsequent events will still be recorded.",
      } })}\n`);
      const rotated = bytes + line.length > maxBytes;
      if (rotated) compact(bytes + line.length - maxBytes);
      write(line, bytes); bytes += line.length;
      if (rotated && !notified) { notified = true; options.onLimit?.(); }
    },
    close() { if (!closed) { closed = true; closeSync(descriptor); } },
  };
}

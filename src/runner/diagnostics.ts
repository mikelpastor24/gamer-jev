import type { DiagnosticSink } from "../core/diagnostics.js";

interface DiagnosticOptions {
  readonly verbose?: boolean;
  readonly secrets?: readonly string[];
  readonly writeLine?: (line: string) => void;
}

/** Redact known credentials and secret-bearing keys before either output receives an event. */
export function redactLogEvent(event: unknown, secrets: readonly string[] = []): unknown {
  const tokens = secrets.filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
  return JSON.parse(JSON.stringify(event, (key, value: unknown) => {
    if (/(authorization|api[_-]?key|access[_-]?token|secret|password|cookie)$/i.test(key)) return "[REDACTED]";
    if (typeof value !== "string") return value;
    let text = value.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]");
    for (const token of tokens) text = text.replaceAll(token, "[REDACTED]");
    return text;
  }) ?? "null") as unknown;
}

export function createDiagnosticLogger(record: (event: unknown) => void, options: DiagnosticOptions = {}): DiagnosticSink {
  return (event) => {
    const safe = redactLogEvent({ type: "diagnostic", ...event }, options.secrets) as typeof event;
    record(safe);
    if (options.verbose || event.level === "warn" || event.level === "error") {
      const at = new Date().toISOString();
      const frame = safe.frame === undefined ? "" : ` frame=${safe.frame}`;
      (options.writeLine ?? console.error)(`${at} [${safe.component}] ${safe.level} ${safe.event}${frame}${safe.data ? ` ${JSON.stringify(safe.data)}` : ""}`);
    }
  };
}

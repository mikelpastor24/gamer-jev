import type { DiagnosticSink } from "../core/diagnostics.js";
import { redactLogEvent } from "../core/redaction.js";
export { redactLogEvent } from "../core/redaction.js";

interface DiagnosticOptions {
  readonly verbose?: boolean;
  readonly secrets?: readonly string[];
  readonly writeLine?: (line: string) => void;
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

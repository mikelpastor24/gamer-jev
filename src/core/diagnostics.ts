export interface DiagnosticEvent {
  readonly component: "agent" | "game-reader" | "jev" | "provider";
  readonly level: "debug" | "info" | "warn" | "error";
  readonly event: string;
  readonly frame?: number;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Optional local diagnostics. Never pass credentials, HTTP headers, or raw provider bodies. */
export type DiagnosticSink = (event: DiagnosticEvent) => void;

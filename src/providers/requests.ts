import { setTimeout as delay } from "node:timers/promises";

export class AgentFailure extends Error {}

export interface RequestLimits {
  readonly maxRequests: number;
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly retries: number;
}

/** Shared by vision and Jev; every application HTTP attempt is counted. */
export class RequestBudget {
  requests = 0;
  private lastRequest = 0;

  constructor(readonly limits: RequestLimits) {
    for (const [name, number] of Object.entries(limits)) {
      if (!Number.isSafeInteger(number) || number < (name === "retries" || name === "intervalMs" ? 0 : 1)) {
        throw new Error(`Invalid request limit: ${name}.`);
      }
    }
    if (limits.retries > 2) throw new Error("At most two retries are supported.");
  }

  async run<T>(kind: "Vision" | "Jev", signal: AbortSignal, request: (signal: AbortSignal) => Promise<T>, provider: "gateway" | "typesafe" = "gateway"): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      if (this.requests >= this.limits.maxRequests) throw new AgentFailure("Model request limit reached.");
      const wait = Math.max(0, this.lastRequest + this.limits.intervalMs - Date.now());
      if (wait) await delay(wait, undefined, { signal });
      signal.throwIfAborted();
      this.requests++;
      this.lastRequest = Date.now();
      const timeout = AbortSignal.timeout(this.limits.timeoutMs);
      try {
        const combined = AbortSignal.any([signal, timeout]);
        const value = await abortable(request, combined);
        signal.throwIfAborted();
        if (timeout.aborted) throw new AgentFailure(`${kind} request timed out.`);
        return value;
      } catch (error: unknown) {
        signal.throwIfAborted();
        if (timeout.aborted) throw new AgentFailure(`${kind} request timed out.`);
        const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
        if (attempt < this.limits.retries && typeof status === "number" && (status === 429 || status >= 500)) {
          await delay(500 * 2 ** attempt, undefined, { signal });
          continue;
        }
        // Never forward transport errors: they can contain credentials or response bodies.
        if (status === 401 || status === 403) throw new AgentFailure(provider === "typesafe" ?
          `${kind} authentication failed. Check TYPESAFE_API_KEY and TypeSafe access.` :
          `${kind} authentication failed. Check AI_GATEWAY_API_KEY and Gateway access.`);
        throw new AgentFailure(`${kind} request failed${typeof status === "number" ? ` (HTTP ${status})` : ""}. Check provider access, credits, model availability, and network connectivity.`);
      }
    }
  }
}

async function abortable<T>(request: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([request(signal), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

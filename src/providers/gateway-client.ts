import { AgentFailure } from "./requests.js";
import type { ModelUsage } from "../core/agent.js";

export interface GatewayClientOptions {
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
}
export interface GatewayClient {
  post(path: "evaluate" | "chat/completions", body: unknown, signal: AbortSignal): Promise<Record<string, unknown>>;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentFailure("Invalid model response object.");
  return value as Record<string, unknown>;
}

export function usage(value: unknown, input: string, output: string): ModelUsage {
  const record = value === undefined ? {} : object(value);
  const count = (name: string): number => {
    const number = record[name] ?? 0;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) throw new AgentFailure("Invalid model token usage.");
    return number;
  };
  return { inputTokens: count(input), outputTokens: count(output) };
}

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  if (!options.apiKey.trim() || options.apiKey === "replace-with-your-vercel-ai-gateway-key") {
    throw new Error("Set AI_GATEWAY_API_KEY in .env to use Jev with vision. Use --agent mock for an offline session.");
  }
  const request = async (path: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const response = await (options.fetch ?? globalThis.fetch)(`https://ai-gateway.vercel.sh/v1/${path}`, {
      method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw { statusCode: response.status };
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !response.body) {
      await response.body?.cancel();
      throw new AgentFailure("Expected a JSON model response.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 262_144) throw new AgentFailure("Model response exceeds 256 KiB.");
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  };
  return { post: request };
}

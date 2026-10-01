import { postJson } from "./http-client.js";
import type { JsonClientOptions } from "./http-client.js";

export type GatewayClientOptions = JsonClientOptions;
export interface GatewayClient {
  post(path: "evaluate" | "chat/completions", body: unknown, signal: AbortSignal): Promise<Record<string, unknown>>;
}

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  if (!options.apiKey.trim() || options.apiKey === "replace-with-your-vercel-ai-gateway-key") {
    throw new Error("Set AI_GATEWAY_API_KEY in .env for the selected Gateway provider.");
  }
  return { post: (path, body, signal) => postJson(options, `https://ai-gateway.vercel.sh/v1/${path}`, body, signal) };
}

import type { DecisionProvider, DecisionProviderId, VisionProvider, VisionProviderId } from "../core/agent.js";
import { createGatewayDecisionProvider } from "../jev/gateway.js";
import { createTypeSafeDecisionProvider } from "../jev/typesafe.js";
import { createMockDecisionProvider } from "../jev/mock.js";
import { createGatewayVisionProvider } from "../vision/gateway.js";
import { createMockVisionProvider } from "../vision/mock.js";
import type { RequestBudget } from "./requests.js";

export interface ProviderSettings {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly budget: RequestBudget;
  readonly fetch?: typeof globalThis.fetch;
}

/** Only the selected decision provider reads its credentials and model setting. */
export function createDecisionProvider(id: DecisionProviderId, settings: ProviderSettings): DecisionProvider {
  const { environment, budget, fetch } = settings;
  if (id === "mock") return createMockDecisionProvider();
  if (id === "typesafe") return createTypeSafeDecisionProvider({ apiKey: environment.TYPESAFE_API_KEY ?? "",
    model: environment.TYPESAFE_MODEL ?? "jev-latest", budget, ...(fetch ? { fetch } : {}) });
  return createGatewayDecisionProvider({ apiKey: environment.AI_GATEWAY_API_KEY ?? "",
    model: environment.JEV_MODEL ?? "typesafe-ai/jev", budget, ...(fetch ? { fetch } : {}) });
}

/** Vision is independently selectable, including with a mock decision provider. */
export function createVisionProvider(id: VisionProviderId, settings: ProviderSettings): VisionProvider | undefined {
  if (id === "none") return undefined;
  if (id === "mock") return createMockVisionProvider();
  const { environment, budget, fetch } = settings;
  return createGatewayVisionProvider({ apiKey: environment.AI_GATEWAY_API_KEY ?? "",
    model: environment.VISION_MODEL ?? "google/gemini-2.5-flash", budget, ...(fetch ? { fetch } : {}) });
}

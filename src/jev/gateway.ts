import type { DecisionProvider } from "../core/agent.js";
import { createGatewayClient } from "../providers/gateway-client.js";
import type { GatewayClientOptions } from "../providers/gateway-client.js";
import { object, usage } from "../providers/http-client.js";
import { RequestBudget } from "../providers/requests.js";
import { choiceAnswer, choiceConfidence, evaluationRequest } from "./evaluation.js";

export interface GatewayDecisionOptions extends GatewayClientOptions { readonly model: string; readonly budget: RequestBudget }

export function createGatewayDecisionProvider(options: GatewayDecisionOptions): DecisionProvider {
  const client = createGatewayClient(options);
  if (!/^typesafe-ai\/[a-zA-Z0-9._-]+$/.test(options.model)) throw new Error("JEV_MODEL must identify a TypeSafe Jev model on AI Gateway.");
  return {
    async decide(context, signal) {
      const result = await options.budget.run("Jev", signal, (abortSignal) => client.post("evaluate", evaluationRequest(context, options.model), abortSignal));
      const { actionId, probabilities } = choiceAnswer(result, context.actions);
      const metadata = result.providerMetadata === undefined ? {} : object(result.providerMetadata);
      const typesafe = metadata.typesafe === undefined ? {} : object(metadata.typesafe);
      const confidences = typesafe.confidence === undefined ? {} : object(typesafe.confidence);
      return { actionId, probabilities, confidence: choiceConfidence(confidences.next_action),
        model: options.model, usage: usage(result.usage, "inputTokens", "outputTokens") };
    },
  };
}

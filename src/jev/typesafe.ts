import type { DecisionProvider } from "../core/agent.js";
import { postJson, usage } from "../providers/http-client.js";
import type { JsonClientOptions } from "../providers/http-client.js";
import { AgentFailure, RequestBudget } from "../providers/requests.js";
import { choiceAnswer, choiceConfidence, evaluationRequest } from "./evaluation.js";
import type { DiagnosticSink } from "../core/diagnostics.js";
import { inspectResponse, privateInspection } from "./inspection.js";

export interface TypeSafeDecisionOptions extends JsonClientOptions { readonly model: string; readonly budget: RequestBudget; readonly diagnostics?: DiagnosticSink }

/** Direct TypeSafe HTTP API: https://docs.typesafe.ai/api */
export function createTypeSafeDecisionProvider(options: TypeSafeDecisionOptions): DecisionProvider {
  if (!options.apiKey.trim() || options.apiKey === "replace-with-your-typesafe-api-key") throw new Error("Set TYPESAFE_API_KEY in .env for direct Jev decisions.");
  if (!/^jev-[a-zA-Z0-9._-]{1,100}$/.test(options.model)) throw new Error("TYPESAFE_MODEL must be a direct TypeSafe Jev model ID, such as jev-latest.");
  return {
    async decide(context, signal, inspect) {
      const inspection = privateInspection(inspect, options.apiKey);
      const request = evaluationRequest(context, options.model);
      inspection({ type: "request", data: request });
      const result = await options.budget.run("Jev", signal, (abortSignal) =>
        postJson(options, "https://api.typesafe.ai/v1/systemone", request, abortSignal), "typesafe");
      inspection({ type: "response", data: inspectResponse(result, context, "typesafe") });
      const report: DiagnosticSink = (event) => {
        options.diagnostics?.({ ...event, frame: context.frame, data: { provider: "typesafe", requestNumber: options.budget.requests, ...event.data } });
        if (event.event === "choice-probability-mismatch") inspection({ type: "warning",
          message: `Jev chose ${event.data?.choice} (${event.data?.selectedProbability}); another action has probability ${event.data?.highestProbability}. Jev's choice was preserved.` });
      };
      try {
        const { actionId, probabilities, answerConfidence } = choiceAnswer(result, context.actions, true, report);
        if (typeof result.model !== "string" || !/^jev-[a-zA-Z0-9._-]{1,100}$/.test(result.model)) throw new AgentFailure("TypeSafe returned an invalid model ID.");
        return { actionId, probabilities, confidence: choiceConfidence(answerConfidence, true),
          model: result.model, usage: usage(result.usage, "input_tokens", "output_tokens", true) };
      } catch (error: unknown) {
        report({ component: "jev", level: "error", event: "validation-failed", data: {
          reason: error instanceof AgentFailure ? error.message : "Invalid TypeSafe response.",
          actionIds: context.actions.map((action) => action.id),
        } });
        throw error;
      }
    },
  };
}

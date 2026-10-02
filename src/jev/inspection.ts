import type { DecisionContext, DecisionInspectionSink } from "../core/agent.js";
import { redactLogEvent } from "../core/redaction.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** Inspect only known numeric/validated fields, including fields of a rejected response. */
export function inspectResponse(result: Record<string, unknown>, context: DecisionContext, provider: "typesafe" | "gateway") {
  const answer = record(record(result.answers).next_action);
  const distribution = record(answer.probabilities);
  const probabilities = Object.fromEntries(context.actions.filter((action) => number(distribution[action.id]) !== null)
    .map((action) => [action.id, distribution[action.id]]));
  const choice = context.actions.some((action) => action.id === answer.choice) ? answer.choice : "[unlisted or missing choice]";
  const usage = record(result.usage);
  const modelPattern = provider === "typesafe" ? /^jev-[a-zA-Z0-9._-]{1,100}$/ : /^typesafe-ai\/[a-zA-Z0-9._-]{1,100}$/;
  const model = typeof result.model === "string" && modelPattern.test(result.model) ? result.model : null;
  const inspected: Record<string, unknown> = { model, answers: { next_action: {
    type: answer.type === "choice" ? "choice" : null, choice,
    ...(answer.probabilities === undefined ? {} : { probabilities }),
    ...(provider === "typesafe" ? { confidence: number(answer.confidence) } : {}),
  } }, usage: provider === "typesafe" ? { input_tokens: number(usage.input_tokens), output_tokens: number(usage.output_tokens) } :
    { inputTokens: number(usage.inputTokens), outputTokens: number(usage.outputTokens) } };
  if (provider === "gateway") {
    const confidence = record(record(record(result.providerMetadata).typesafe).confidence).next_action;
    inspected.providerMetadata = { typesafe: { confidence: { next_action: number(confidence) } } };
  }
  return inspected;
}

export function privateInspection(inspect: DecisionInspectionSink | undefined, apiKey: string): DecisionInspectionSink {
  return (event) => {
    if (inspect) inspect(redactLogEvent(event, [apiKey]) as typeof event);
  };
}

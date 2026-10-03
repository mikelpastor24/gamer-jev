import type { PlayerSelection } from "../core/agent.js";

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

export function providerCatalog(environment: ProviderEnvironment) {
  const configured = (name: string) => {
    const key = environment[name]?.trim();
    return Boolean(key && !key.startsWith("replace-with-"));
  };
  const typesafe = configured("TYPESAFE_API_KEY");
  const gateway = configured("AI_GATEWAY_API_KEY");
  return {
    decisions: [
      { id: "typesafe", name: "TypeSafe (direct)", available: typesafe, credential: "TYPESAFE_API_KEY", model: environment.TYPESAFE_MODEL ?? "jev-latest" },
      { id: "gateway", name: "Vercel AI Gateway", available: gateway, credential: "AI_GATEWAY_API_KEY", model: environment.JEV_MODEL ?? "typesafe-ai/jev" },
      { id: "mock", name: "Offline mock", available: true, credential: null, model: "" },
    ],
    vision: [
      { id: "none", name: "Disabled (memory only)", available: true, credential: null, model: "" },
      { id: "gateway", name: "Vercel AI Gateway", available: gateway, credential: "AI_GATEWAY_API_KEY", model: environment.VISION_MODEL ?? "google/gemini-2.5-flash" },
      { id: "mock", name: "Offline mock", available: true, credential: null, model: "" },
    ],
  };
}

/** Reject unknown fields and bound model IDs without accepting browser credentials. */
export function parsePlayerSelection(value: unknown): PlayerSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid player selection.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !["mode", "decisionProvider", "visionProvider", "decisionModel", "visionModel"].includes(key))) {
    throw new Error("Unknown player setting. Credentials must be configured in .env.");
  }
  if (data.mode !== "manual" && data.mode !== "agent") throw new Error("Player mode must be manual or agent.");
  if (data.decisionProvider !== "typesafe" && data.decisionProvider !== "gateway" && data.decisionProvider !== "mock") throw new Error("Invalid Jev provider.");
  if (data.visionProvider !== "none" && data.visionProvider !== "gateway" && data.visionProvider !== "mock") throw new Error("Invalid vision provider.");
  const model = (value: unknown, name: string) => {
    if (typeof value !== "string" || value.length > 160 || !/^[a-zA-Z0-9._/-]*$/.test(value)) throw new Error(`${name} must be a model identifier of at most 160 characters.`);
    return value;
  };
  const decisionModel = model(data.decisionModel, "Jev model");
  const visionModel = model(data.visionModel, "Vision model");
  if (data.decisionProvider === "typesafe" && !/^jev-[a-zA-Z0-9._-]{1,100}$/.test(decisionModel)) throw new Error("Direct Jev requires a model ID such as jev-latest.");
  if (data.decisionProvider === "gateway" && !/^typesafe-ai\/[a-zA-Z0-9._-]+$/.test(decisionModel)) throw new Error("Gateway Jev requires a TypeSafe model ID such as typesafe-ai/jev.");
  if (data.visionProvider === "gateway" && !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(visionModel)) throw new Error("Vision requires a Gateway provider/model identifier.");
  return { mode: data.mode, decisionProvider: data.decisionProvider, visionProvider: data.visionProvider, decisionModel, visionModel };
}

export function validateProviderAccess(selection: PlayerSelection, environment: ProviderEnvironment): void {
  if (selection.mode === "manual") return;
  const catalog = providerCatalog(environment);
  for (const provider of [catalog.decisions.find((item) => item.id === selection.decisionProvider)!, catalog.vision.find((item) => item.id === selection.visionProvider)!]) {
    if (!provider.available) throw new Error(`Set ${provider.credential} in .env and restart the application to use this provider.`);
  }
}

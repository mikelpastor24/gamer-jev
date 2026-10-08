export interface AutosaveSettings {
  readonly enabled: boolean;
  readonly decisionInterval: number;
  readonly manualSeconds: number;
}

export const DEFAULT_AUTOSAVE_SETTINGS: AutosaveSettings = Object.freeze({
  enabled: false, decisionInterval: 25, manualSeconds: 60,
});

/** Validate a complete update before changing checkpoint scheduling. */
export function parseAutosaveSettings(value: unknown): AutosaveSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid autosave settings.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !["enabled", "decisionInterval", "manualSeconds"].includes(key)) || typeof data.enabled !== "boolean") {
    throw new Error("Invalid autosave settings.");
  }
  const integer = (value: unknown, name: string, maximum: number): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
    }
    return value;
  };
  return { enabled: data.enabled,
    decisionInterval: integer(data.decisionInterval, "Autosave decisions", 10_000),
    manualSeconds: integer(data.manualSeconds, "Autosave seconds", 86_400) };
}

export const MAX_EMULATION_SPEED = 32;

export function parseEmulationSpeed(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_EMULATION_SPEED) {
    throw new Error(`Emulation speed must be greater than 0 and at most ${MAX_EMULATION_SPEED}.`);
  }
  return value;
}

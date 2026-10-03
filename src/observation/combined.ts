import type { ObservationProvider, VisionProvider } from "../core/agent.js";

/** State supplies action availability; optional vision supplies additional evidence. */
export function withVision(state: ObservationProvider, vision: VisionProvider): ObservationProvider {
  return { kind: "vision", ...(state.availableActions ? { availableActions: (frame) => state.availableActions!(frame) } : {}),
    reset() { state.reset?.(); }, setActionFrames(frames) { state.setActionFrames?.(frames); }, async observe(frame, previous, objectives, signal) {
    const local = await state.observe(frame, previous, objectives, signal);
    signal.throwIfAborted();
    const visual = await vision.observe(frame, previous, objectives, signal);
    signal.throwIfAborted();
    return { ...local, text: visual.text, model: visual.model, usage: {
      inputTokens: local.usage.inputTokens + visual.usage.inputTokens,
      outputTokens: local.usage.outputTokens + visual.usage.outputTokens,
    } };
  } };
}

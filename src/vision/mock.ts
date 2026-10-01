import type { VisionProvider } from "../core/agent.js";

export function createMockVisionProvider(): VisionProvider {
  return { async observe(frame, _previous, _objectives, signal) {
    signal.throwIfAborted();
    return { text: `Mock observation at frame ${frame.number}. Screen size ${frame.width} x ${frame.height}. This offline fixture does not interpret game content.`,
      model: "mock-vision", usage: { inputTokens: 0, outputTokens: 0 } };
  } };
}
